use std::ffi::{c_void, OsStr};
use std::fs::{self, OpenOptions};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{ErrorKind, Read, Write};
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::process::Child;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread;
use windows_sys::Win32::Foundation::{
   CloseHandle, GetLastError, LocalFree, ERROR_ALREADY_EXISTS, HANDLE,
};
use windows_sys::Win32::Security::Cryptography::{
   CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};
use windows_sys::Win32::Storage::FileSystem::{
   MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};
use windows_sys::Win32::System::JobObjects::{
   AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
   SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
   JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Power::{
   SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
};
use windows_sys::Win32::System::Registry::{
   RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6432KEY,
   RRF_SUBKEY_WOW6464KEY,
};
use windows_sys::Win32::System::Threading::CreateMutexW;
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
   FindWindowW, MessageBoxW, SetForegroundWindow, ShowWindow, MB_ICONERROR, MB_OK, SW_RESTORE,
   SW_SHOWNORMAL,
};

const TITLE: &str = "Local File Transfer WebView2 Preview";
static TEMPORARY_ID: AtomicU64 = AtomicU64::new(0);

pub struct OwnedHandle(usize);

impl Drop for OwnedHandle {
   fn drop(&mut self) {
      unsafe { CloseHandle(self.0 as HANDLE) };
   }
}

pub fn show_error(message: &str) {
   let title = wide(OsStr::new(TITLE));
   let message = wide(OsStr::new(message));
   unsafe {
      MessageBoxW(
         null_mut(),
         message.as_ptr(),
         title.as_ptr(),
         MB_OK | MB_ICONERROR,
      )
   };
}

pub fn single_instance(data_root: &Path) -> Result<Option<OwnedHandle>, String> {
   let mut hash = DefaultHasher::new();
   data_root
      .as_os_str()
      .to_string_lossy()
      .to_lowercase()
      .hash(&mut hash);
   let name = wide(OsStr::new(&format!(
      "Local\\LocalFileTransferWebView2Preview-{:016x}",
      hash.finish()
   )));
   let handle = unsafe { CreateMutexW(null(), 0, name.as_ptr()) };

   if handle.is_null() {
      return Err("アプリの起動ロックを作成できません。".into());
   }

   let existing = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
   let owned = OwnedHandle(handle as usize);
   if existing {
      let title = wide(OsStr::new(TITLE));
      let window = unsafe { FindWindowW(null(), title.as_ptr()) };
      if !window.is_null() {
         unsafe {
            ShowWindow(window, SW_RESTORE);
            SetForegroundWindow(window);
         }
      }
      drop(owned);
      return Ok(None);
   }
   Ok(Some(owned))
}

pub fn webview2_installed() -> bool {
   let key = wide(OsStr::new(
      "Software\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
   ));
   let value = wide(OsStr::new("pv"));
   for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
      for view in [RRF_SUBKEY_WOW6432KEY, RRF_SUBKEY_WOW6464KEY] {
         let mut buffer = [0u16; 128];
         let mut bytes = (buffer.len() * 2) as u32;
         let result = unsafe {
            RegGetValueW(
               root,
               key.as_ptr(),
               value.as_ptr(),
               RRF_RT_REG_SZ | view,
               null_mut(),
               buffer.as_mut_ptr().cast(),
               &mut bytes,
            )
         };
         if result == 0 {
            let length = buffer.iter().position(|v| *v == 0).unwrap_or(buffer.len());
            let version = String::from_utf16_lossy(&buffer[..length]);
            if !version.is_empty() && version != "0.0.0.0" {
               return true;
            }
         }
      }
   }
   false
}

pub fn child_job(child: &Child) -> Result<OwnedHandle, String> {
   let job = unsafe { CreateJobObjectW(null(), null()) };
   if job.is_null() {
      return Err("転送サービスの管理領域を作成できません。".into());
   }
   let owned = OwnedHandle(job as usize);
   let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
   information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
   let configured = unsafe {
      SetInformationJobObject(
         job,
         JobObjectExtendedLimitInformation,
         (&information as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
         size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
      )
   };
   let assigned = configured != 0
      && unsafe { AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) } != 0;
   if !assigned {
      return Err("転送サービスの終了管理を設定できません。".into());
   }
   Ok(owned)
}

pub fn load_credential(path: &Path) -> Result<Option<Vec<u8>>, String> {
   let file = match fs::File::open(path) {
      Ok(file) => file,
      Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
      Err(_) => {
         return Err(
            "保存済みの認証情報を読み込めません。保存先のアクセス権を確認してください。".into(),
         )
      }
   };
   let mut bytes = Vec::new();
   file
      .take(64 * 1024 + 1)
      .read_to_end(&mut bytes)
      .map_err(|_| "保存済みの認証情報を読み込めません。".to_string())?;
   if bytes.is_empty() || bytes.len() > 64 * 1024 {
      return Err("保存済みの認証情報が破損しています。データをバックアップしてから保存先を確認してください。".into());
   }
   protect(&bytes, false).map(Some).map_err(|_| {
      "保存済みの認証情報を復号できません。保存時と同じ Windows ユーザーで起動してください。"
         .to_string()
   })
}

pub fn save_credential(path: &Path, plain: &[u8]) -> Result<(), String> {
   let encrypted = protect(plain, true)?;
   let identifier = TEMPORARY_ID.fetch_add(1, Ordering::Relaxed);
   let temporary = path.with_extension(format!("{}.{}.tmp", std::process::id(), identifier));
   let result = (|| {
      let mut file = OpenOptions::new()
         .create_new(true)
         .write(true)
         .open(&temporary)
         .map_err(|_| "認証情報の保存先を作成できません。".to_string())?;
      file
         .write_all(&encrypted)
         .and_then(|_| file.sync_all())
         .map_err(|_| "認証情報を保存できません。".to_string())?;
      drop(file);
      let from = wide(temporary.as_os_str());
      let to = wide(path.as_os_str());
      if unsafe {
         MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
         )
      } == 0
      {
         return Err("認証情報を更新できません。".into());
      }
      Ok(())
   })();
   if result.is_err() {
      let _ = fs::remove_file(&temporary);
   }
   result
}

fn protect(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
   if bytes.len() > 64 * 1024 {
      return Err("認証情報の形式が正しくありません。".into());
   }
   let input = CRYPT_INTEGER_BLOB {
      cbData: bytes.len() as u32,
      pbData: bytes.as_ptr() as *mut u8,
   };
   let mut output: CRYPT_INTEGER_BLOB = unsafe { zeroed() };
   // Without CRYPTPROTECT_LOCAL_MACHINE, DPAPI protects the record for this user.
   let result = unsafe {
      if encrypt {
         CryptProtectData(
            &input,
            null(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
         )
      } else {
         CryptUnprotectData(
            &input,
            null_mut(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
         )
      }
   };
   if result == 0 {
      return Err("Windows による認証情報の保護に失敗しました。".into());
   }
   let result =
      unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
   unsafe { LocalFree(output.pbData.cast::<c_void>()) };
   Ok(result)
}

pub fn open_folder(path: &Path) -> Result<(), String> {
   if !path.is_absolute() || !path.is_dir() {
      return Err("フォルダーを開けません。".into());
   }
   shell_open(path.as_os_str(), None)
}

pub fn show_file(path: &Path) -> Result<(), String> {
   if !path.is_absolute() || !path.is_file() {
      return Err("受信ファイルが見つかりません。".into());
   }
   let display = path.as_os_str().to_string_lossy();
   if display.contains('"') || display.contains('\0') {
      return Err("受信ファイルの場所が正しくありません。".into());
   }
   let parameter = format!("/select,\"{display}\"");
   shell_open(OsStr::new("explorer.exe"), Some(OsStr::new(&parameter)))
}

fn shell_open(file: &OsStr, parameters: Option<&OsStr>) -> Result<(), String> {
   let operation = wide(OsStr::new("open"));
   let file = wide(file);
   let arguments = parameters.map(wide);
   let result = unsafe {
      ShellExecuteW(
         null_mut(),
         operation.as_ptr(),
         file.as_ptr(),
         arguments.as_ref().map_or(null(), |value| value.as_ptr()),
         null(),
         SW_SHOWNORMAL,
      )
   };
   if result as isize <= 32 {
      return Err("エクスプローラーを開けません。".into());
   }
   Ok(())
}

pub struct PowerGuard(mpsc::Sender<bool>);

impl PowerGuard {
   pub fn new() -> Self {
      let (sender, receiver) = mpsc::channel();
      thread::spawn(move || {
         let mut active = false;
         while let Ok(next) = receiver.recv() {
            if active != next {
               let flags = if next {
                  ES_CONTINUOUS | ES_SYSTEM_REQUIRED
               } else {
                  ES_CONTINUOUS
               };
               unsafe { SetThreadExecutionState(flags) };
               active = next;
            }
         }
         unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
      });
      Self(sender)
   }

   pub fn set(&self, active: bool) {
      let _ = self.0.send(active);
   }
}

fn wide(value: &OsStr) -> Vec<u16> {
   value.encode_wide().chain(Some(0)).collect()
}

#[cfg(test)]
mod tests {
   use super::{load_credential, save_credential};
   use std::fs;
   use std::path::PathBuf;
   use std::time::{SystemTime, UNIX_EPOCH};

   struct TestDirectory(PathBuf);

   impl TestDirectory {
      fn new() -> Self {
         let identifier = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
         let path = std::env::temp_dir().join(format!(
            "lft-preview-dpapi-{}-{identifier}",
            std::process::id()
         ));
         fs::create_dir(&path).expect("Temporary DPAPI test directory");
         Self(path)
      }
   }

   impl Drop for TestDirectory {
      fn drop(&mut self) {
         let _ = fs::remove_dir_all(&self.0);
      }
   }

   #[test]
   fn credential_is_encrypted_and_atomic_replacement_remains_readable() {
      let directory = TestDirectory::new();
      let path = directory.0.join("credential.bin");
      let first = br#"{"roomId":"unit-room","token":"unit-test-capability-first"}"#;
      let second = br#"{"roomId":"next-room","token":"unit-test-capability-second"}"#;
      assert!(load_credential(&path)
         .expect("Missing credential")
         .is_none());
      save_credential(&path, first).expect("Protect initial credential");
      let encrypted = fs::read(&path).expect("Encrypted credential");
      assert!(!encrypted.windows(first.len()).any(|part| part == first));
      assert_eq!(
         load_credential(&path)
            .expect("Unprotect initial credential")
            .as_deref(),
         Some(first.as_slice())
      );
      save_credential(&path, second).expect("Atomically replace credential");
      assert_eq!(
         load_credential(&path)
            .expect("Unprotect replaced credential")
            .as_deref(),
         Some(second.as_slice())
      );
      assert_eq!(
         fs::read_dir(&directory.0)
            .expect("Credential directory")
            .count(),
         1
      );
   }

   #[test]
   fn corrupt_or_empty_credential_is_an_error_instead_of_a_new_room() {
      let directory = TestDirectory::new();
      let path = directory.0.join("credential.bin");
      fs::write(&path, []).expect("Empty credential fixture");
      assert!(load_credential(&path).is_err());
      fs::write(&path, b"invalid-dpapi-record").expect("Corrupt credential fixture");
      assert!(load_credential(&path).is_err());
      assert!(load_credential(&directory.0).is_err());
   }
}
