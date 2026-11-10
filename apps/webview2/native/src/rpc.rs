use crate::platform::{child_job, OwnedHandle};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const MAX_LINE: usize = 1024 * 1024;
pub const CREDENTIAL_REJECTED: &str = "保存済みの認証情報が転送ルームと一致しません。データをバックアップしてから保存先を確認してください。";
type Reply = Result<Value, String>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Response {
   request_id: String,
   ok: bool,
   result: Option<Value>,
   error: Option<String>,
}

pub struct RpcProcess {
   child: Mutex<Child>,
   input: Mutex<Option<ChildStdin>>,
   pending: Mutex<HashMap<String, mpsc::Sender<Reply>>>,
   alive: AtomicBool,
   sequence: AtomicU64,
   _job: OwnedHandle,
}

impl RpcProcess {
   pub fn start(executable: &Path) -> Result<Arc<Self>, String> {
      let mut child = Command::new(executable)
         .stdin(Stdio::piped())
         .stdout(Stdio::piped())
         .stderr(Stdio::null())
         .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
         .spawn()
         .map_err(|_| {
            "転送サービスを起動できません。配布フォルダーを確認してください。".to_string()
         })?;
      let job = match child_job(&child) {
         Ok(job) => job,
         Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
         }
      };
      let input = child
         .stdin
         .take()
         .ok_or("転送サービスの入力を開けません。")?;
      let output = child
         .stdout
         .take()
         .ok_or("転送サービスの出力を開けません。")?;
      let process = Arc::new(Self {
         child: Mutex::new(child),
         input: Mutex::new(Some(input)),
         pending: Mutex::new(HashMap::new()),
         alive: AtomicBool::new(true),
         sequence: AtomicU64::new(0),
         _job: job,
      });
      let reader_process = process.clone();
      thread::spawn(move || {
         let mut reader = BufReader::new(output);
         loop {
            let mut bytes = Vec::new();
            let read = (&mut reader)
               .take((MAX_LINE + 1) as u64)
               .read_until(b'\n', &mut bytes);
            if read.is_err()
               || bytes.is_empty()
               || bytes.len() > MAX_LINE
               || bytes.last() != Some(&b'\n')
            {
               break;
            }
            let Ok(response) = serde_json::from_slice::<Response>(&bytes) else {
               break;
            };
            let sender = reader_process
               .pending
               .lock()
               .ok()
               .and_then(|mut pending| pending.remove(&response.request_id));
            if let Some(sender) = sender {
               let result = if response.ok {
                  Ok(response.result.unwrap_or(Value::Null))
               } else if response.error.as_deref() == Some("request-failed-401") {
                  Err(CREDENTIAL_REJECTED.into())
               } else {
                  // The renderer never receives raw service exception text or paths.
                  Err("転送サービスで処理を完了できませんでした。".into())
               };
               let _ = sender.send(result);
            }
         }
         reader_process.fail_pending();
      });
      Ok(process)
   }

   pub fn call(&self, action: &str, payload: Value) -> Reply {
      self.call_timeout(action, payload, Duration::from_secs(30))
   }

   fn call_timeout(&self, action: &str, payload: Value, timeout: Duration) -> Reply {
      if !self.alive.load(Ordering::Acquire) {
         return Err("転送サービスに再接続しています。".into());
      }
      let identifier = format!("native-{}", self.sequence.fetch_add(1, Ordering::Relaxed));
      let mut bytes = serde_json::to_vec(
         &json!({"requestId": identifier, "action": action, "payload": payload}),
      )
      .map_err(|_| "転送サービスへの要求が正しくありません。".to_string())?;
      bytes.push(b'\n');
      if bytes.len() > MAX_LINE {
         return Err("一度に選択したファイルが多すぎます。".into());
      }
      let (sender, receiver) = mpsc::channel();
      self
         .pending
         .lock()
         .map_err(|_| "転送サービスへ接続できません。".to_string())?
         .insert(identifier.clone(), sender);
      let written = self.input.lock().ok().and_then(|mut input| {
         input
            .as_mut()
            .map(|input| input.write_all(&bytes).and_then(|_| input.flush()))
      });
      if !matches!(written, Some(Ok(()))) {
         self.fail_pending();
         return Err("転送サービスへ接続できません。".into());
      }
      match receiver.recv_timeout(timeout) {
         Ok(reply) => reply,
         Err(_) => {
            if let Ok(mut pending) = self.pending.lock() {
               pending.remove(&identifier);
            }
            Err("転送サービスの応答を確認できませんでした。".into())
         }
      }
   }

   pub fn is_running(&self) -> bool {
      if !self.alive.load(Ordering::Acquire) {
         return false;
      }
      let running = self
         .child
         .lock()
         .map(|mut child| matches!(child.try_wait(), Ok(None)))
         .unwrap_or(false);
      if !running {
         self.fail_pending();
      }
      running
   }

   pub fn shutdown(&self) {
      let _ = self.call_timeout("shutdown", Value::Null, Duration::from_secs(3));
      if let Ok(mut input) = self.input.lock() {
         input.take();
      }
      let deadline = Instant::now() + Duration::from_secs(3);
      loop {
         let exited = self
            .child
            .lock()
            .map(|mut child| matches!(child.try_wait(), Ok(Some(_))))
            .unwrap_or(true);
         if exited {
            break;
         }
         if Instant::now() >= deadline {
            if let Ok(mut child) = self.child.lock() {
               let _ = child.kill();
               let _ = child.wait();
            }
            break;
         }
         thread::sleep(Duration::from_millis(20));
      }
      self.fail_pending();
   }

   fn fail_pending(&self) {
      self.alive.store(false, Ordering::Release);
      if let Ok(mut pending) = self.pending.lock() {
         for (_, sender) in pending.drain() {
            let _ = sender.send(Err("転送サービスに再接続しています。".into()));
         }
      }
   }
}
