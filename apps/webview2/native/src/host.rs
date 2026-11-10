use crate::platform::{self, PowerGuard};
use crate::rpc::{RpcProcess, CREDENTIAL_REJECTED};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::ipc::CapabilityBuilder;
use tauri::webview::{NewWindowResponse, PageLoadEvent, PermissionResponse};
use tauri::{
   AppHandle, DragDropEvent, LogicalSize, Manager, RunEvent, State, Url, WebviewUrl, WebviewWindow,
   WebviewWindowBuilder, WindowEvent,
};

const TITLE: &str = "Local File Transfer WebView2 Preview";
// Tauri resolves App("index.html") to the app base URL on Windows.
const LOADING_URL: &str = "http://tauri.localhost/";
const ALLOWED_COMMANDS: &[&str] = &[
   "room-bootstrap",
   "choose-files",
   "reset-room",
   "get-diagnostics",
   "show-received-file",
   "open-receive-folder",
   "open-log-folder",
   "resize-to-content",
   "set-transfer-active",
];

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Credential {
   room_id: String,
   token: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Runtime {
   port: u16,
   local_url: String,
   receive_dir: PathBuf,
   log_dir: PathBuf,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
   room_id: String,
   join_url: String,
   expires_at: u64,
   #[serde(skip_serializing_if = "Option::is_none")]
   view: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
   runtime: Runtime,
   bootstrap: Bootstrap,
   credential: Credential,
   transfer_active: bool,
}

pub struct HostState {
   data_root: PathBuf,
   executable_root: PathBuf,
   service: Mutex<Option<Arc<RpcProcess>>>,
   runtime: Mutex<Option<Runtime>>,
   credential: Mutex<Option<Credential>>,
   snapshot_gate: Mutex<()>,
   allowed_url: RwLock<Option<Url>>,
   loading_message: Mutex<String>,
   closing: AtomicBool,
   native_active: AtomicBool,
   renderer_active: AtomicBool,
   power: PowerGuard,
}

impl HostState {
   fn new(data_root: PathBuf, executable_root: PathBuf) -> Result<Self, String> {
      let credential = match platform::load_credential(&data_root.join("credential.bin"))? {
         Some(mut bytes) => {
            let parsed = serde_json::from_slice::<Credential>(&bytes);
            bytes.fill(0);
            let credential =
               parsed.map_err(|_| "保存済みの認証情報の形式が正しくありません。".to_string())?;
            if credential.room_id.is_empty()
               || credential.room_id.len() > 128
               || credential.token.is_empty()
               || credential.token.len() > 4096
            {
               return Err("保存済みの認証情報の形式が正しくありません。".into());
            }
            Some(credential)
         }
         None => None,
      };
      Ok(Self {
         data_root,
         executable_root,
         service: Mutex::new(None),
         runtime: Mutex::new(None),
         credential: Mutex::new(credential),
         snapshot_gate: Mutex::new(()),
         allowed_url: RwLock::new(None),
         loading_message: Mutex::new("転送ルームを準備しています。".into()),
         closing: AtomicBool::new(false),
         native_active: AtomicBool::new(false),
         renderer_active: AtomicBool::new(false),
         power: PowerGuard::new(),
      })
   }

   fn client(&self) -> Result<Arc<RpcProcess>, String> {
      if self.closing.load(Ordering::Acquire) {
         return Err("アプリを終了しています。".into());
      }
      self
         .service
         .lock()
         .map_err(|_| "転送サービスを確認できません。".to_string())?
         .clone()
         .filter(|service| service.is_running())
         .ok_or_else(|| "転送サービスに再接続しています。".to_string())
   }

   fn snapshot(&self, action: &str) -> Result<Bootstrap, String> {
      let _gate = self
         .snapshot_gate
         .lock()
         .map_err(|_| "転送ルームを確認できません。".to_string())?;
      let value = self.client()?.call(action, Value::Null)?;
      let snapshot: Snapshot = serde_json::from_value(value)
         .map_err(|_| "転送ルームの応答が正しくありません。".to_string())?;
      let expected = self.allowed_url.read().ok().and_then(|url| url.clone());
      if expected.as_ref() != Some(&runtime_url(&snapshot.runtime)?) {
         return Err("転送サービスに再接続しています。".into());
      }
      self.apply_snapshot(snapshot)
   }

   fn apply_snapshot(&self, snapshot: Snapshot) -> Result<Bootstrap, String> {
      if self.closing.load(Ordering::Acquire) {
         return Err("アプリを終了しています。".into());
      }
      validate_snapshot(&snapshot, &self.data_root)?;
      let mut credential = self
         .credential
         .lock()
         .map_err(|_| "認証情報を確認できません。".to_string())?;
      if credential.as_ref() != Some(&snapshot.credential) {
         let mut bytes = serde_json::to_vec(&snapshot.credential)
            .map_err(|_| "認証情報の形式が正しくありません。".to_string())?;
         let saved = platform::save_credential(&self.data_root.join("credential.bin"), &bytes);
         bytes.fill(0);
         saved?;
         *credential = Some(snapshot.credential);
      }
      *self
         .runtime
         .lock()
         .map_err(|_| "転送サービスを確認できません。".to_string())? = Some(snapshot.runtime);
      self
         .native_active
         .store(snapshot.transfer_active, Ordering::Release);
      self.update_power();
      Ok(snapshot.bootstrap)
   }

   fn update_power(&self) {
      let active = !self.closing.load(Ordering::Acquire)
         && (self.native_active.load(Ordering::Acquire)
            || self.renderer_active.load(Ordering::Acquire));
      self.power.set(active);
   }

   fn clear_service(&self) {
      if let Ok(mut service) = self.service.lock() {
         service.take();
      }
      if let Ok(mut runtime) = self.runtime.lock() {
         runtime.take();
      }
      if let Ok(mut url) = self.allowed_url.write() {
         url.take();
      }
      self.native_active.store(false, Ordering::Release);
      self.renderer_active.store(false, Ordering::Release);
      self.update_power();
   }
}

pub fn run() {
   if !platform::webview2_installed() {
      platform::show_error("Microsoft Edge WebView2 Runtime が必要です。\n\nMicrosoft の WebView2 配布ページから Evergreen Runtime を導入してから、もう一度起動してください。\nこの試作は Runtime を自動ダウンロードしません。");
      return;
   }
   let (data_root, executable_root) = match paths() {
      Ok(paths) => paths,
      Err(error) => {
         platform::show_error(&error);
         return;
      }
   };
   let _single_instance = match platform::single_instance(&data_root) {
      Ok(Some(lock)) => lock,
      Ok(None) => return,
      Err(error) => {
         platform::show_error(&error);
         return;
      }
   };
   let state = match HostState::new(data_root, executable_root) {
      Ok(state) => Arc::new(state),
      Err(error) => {
         platform::show_error(&error);
         return;
      }
   };
   let setup_state = state.clone();
   let app = tauri::Builder::default()
      .manage(state.clone())
      .invoke_handler(tauri::generate_handler![
         room_bootstrap,
         choose_files,
         reset_room,
         get_diagnostics,
         show_received_file,
         open_receive_folder,
         open_log_folder,
         resize_to_content,
         set_transfer_active,
      ])
      .setup(move |app| {
         let navigation_state = setup_state.clone();
         let loading_state = setup_state.clone();
         let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
            .title(TITLE)
            .inner_size(300.0, 360.0)
            .min_inner_size(300.0, 340.0)
            .max_inner_size(300.0, 1600.0)
            .maximizable(false)
            .devtools(false)
            .data_directory(setup_state.data_root.join("browser"))
            .initialization_script(include_str!("../../dist/bridge.js"))
            .on_navigation(move |url| navigation_allowed(&navigation_state, url))
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_permission_request(|_, _| PermissionResponse::Deny)
            .on_page_load(move |window, payload| {
               if payload.event() == PageLoadEvent::Finished
                  && payload.url().as_str() == LOADING_URL
               {
                  if let Ok(message) = loading_state.loading_message.lock() {
                     update_status(&window, &message);
                  }
               }
            })
            .build()?;

         let event_app = app.handle().clone();
         let event_state = setup_state.clone();
         window.on_window_event(move |event| match event {
            WindowEvent::CloseRequested { api, .. } => {
               api.prevent_close();
               begin_shutdown(event_app.clone(), event_state.clone());
            }
            WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
               let app = event_app.clone();
               let state = event_state.clone();
               let paths = paths.clone();
               tauri::async_runtime::spawn(async move {
                  let Some(window) = app.get_webview_window("main") else {
                     return;
                  };
                  if authorize(&window, &state).is_err() {
                     return;
                  }
                  let result = blocking(move || add_paths(&state, paths)).await;
                  match result {
                     Ok(room) => emit_dom(&window, "local-file-transfer:files-added", &room),
                     Err(_) => emit_dom(
                        &window,
                        "local-file-transfer:files-error",
                        &json!("ファイルを追加できませんでした。もう一度お試しください。"),
                     ),
                  }
               });
            }
            _ => {}
         });
         let supervisor_app = app.handle().clone();
         let supervisor_state = setup_state.clone();
         thread::spawn(move || supervise(supervisor_app, supervisor_state));
         Ok(())
      })
      .build(tauri::generate_context!());

   let app = match app {
      Ok(app) => app,
      Err(_) => {
         platform::show_error("WebView2 の画面を起動できませんでした。Runtime の導入状態と配布フォルダーを確認してください。");
         return;
      }
   };
   app.run(move |handle, event| {
      if let RunEvent::ExitRequested { api, .. } = event {
         if !state.closing.load(Ordering::Acquire) {
            api.prevent_exit();
            begin_shutdown(handle.clone(), state.clone());
         }
      }
   });
}

fn paths() -> Result<(PathBuf, PathBuf), String> {
   let data_root = if let Some(path) = std::env::var_os("LFT_WEBVIEW2_USER_DATA_DIR") {
      PathBuf::from(path)
   } else {
      PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("Windows の保存先を確認できません。")?)
         .join("LocalFileTransferWebView2Preview")
   };
   if !data_root.is_absolute() {
      return Err("試作版の保存先は絶対パスで指定してください。".into());
   }
   for directory in [
      &data_root,
      &data_root.join("storage"),
      &data_root.join("receive"),
      &data_root.join("browser"),
   ] {
      fs::create_dir_all(directory).map_err(|_| "試作版の保存先を準備できません。".to_string())?;
   }
   let executable =
      std::env::current_exe().map_err(|_| "アプリの場所を確認できません。".to_string())?;
   let executable_root = executable
      .parent()
      .ok_or("アプリの場所を確認できません。")?
      .to_path_buf();
   if !executable_root
      .join("LocalFileTransferService.exe")
      .is_file()
      || !executable_root.join("web/index.html").is_file()
   {
      return Err("配布フォルダーが不完全です。ZIP 全体を展開してから起動してください。".into());
   }
   Ok((data_root, executable_root))
}

fn runtime_url(runtime: &Runtime) -> Result<Url, String> {
   let mut url = Url::parse(&runtime.local_url)
      .map_err(|_| "転送サービスの接続先が正しくありません。".to_string())?;
   if url.scheme() != "http"
      || url.host_str() != Some("127.0.0.1")
      || url.port() != Some(runtime.port)
      || runtime.port == 0
      || !url.username().is_empty()
      || url.password().is_some()
      || url.path() != "/"
      || url.query().is_some()
      || url.fragment().is_some()
   {
      return Err("転送サービスの接続先が正しくありません。".into());
   }
   url.set_path("/app");
   Ok(url)
}

fn validate_snapshot(snapshot: &Snapshot, data_root: &Path) -> Result<(), String> {
   runtime_url(&snapshot.runtime)?;
   if snapshot.runtime.receive_dir != data_root.join("receive")
      || snapshot.runtime.log_dir != data_root.join("storage/logs")
      || snapshot.bootstrap.room_id != snapshot.credential.room_id
      || snapshot.credential.token.is_empty()
      || snapshot.credential.token.len() > 4096
      || snapshot.credential.room_id.len() > 128
   {
      return Err("転送ルームの応答が正しくありません。".into());
   }
   let join = Url::parse(&snapshot.bootstrap.join_url)
      .map_err(|_| "転送ルームの応答が正しくありません。".to_string())?;
   if join.scheme() != "http" || join.fragment().is_none() {
      return Err("転送ルームの応答が正しくありません。".into());
   }
   Ok(())
}

fn navigation_allowed(state: &HostState, url: &Url) -> bool {
   if url.as_str() == LOADING_URL {
      return true;
   }
   state
      .allowed_url
      .read()
      .ok()
      .and_then(|value| value.clone())
      .as_ref()
      == Some(url)
}

fn authorize(window: &WebviewWindow, state: &HostState) -> Result<(), String> {
   if window.label() != "main" || state.closing.load(Ordering::Acquire) {
      return Err("この画面からは操作できません。".into());
   }
   let actual = window
      .url()
      .map_err(|_| "画面の接続先を確認できません。".to_string())?;
   let expected = state.allowed_url.read().ok().and_then(|url| url.clone());
   if expected.as_ref() != Some(&actual) {
      return Err("この画面からは操作できません。".into());
   }
   Ok(())
}

fn capability_remote_url(url: &Url) -> String {
   // Fetch IPC supplies only Origin; postMessage supplies the document URL.
   // authorize() still requires the main window's exact current /app URL.
   format!("{}/*", url.origin().ascii_serialization())
}

fn supervise(app: AppHandle, state: Arc<HostState>) {
   let mut launches = 0u32;
   let mut failures = 0u32;
   while !state.closing.load(Ordering::Acquire) {
      let process = {
         // Close waits for this lock, so a process spawned during early shutdown
         // is always registered before the shutdown worker inspects the child.
         let Ok(mut current) = state.service.lock() else {
            return;
         };
         if state.closing.load(Ordering::Acquire) {
            return;
         }
         let process =
            match RpcProcess::start(&state.executable_root.join("LocalFileTransferService.exe")) {
               Ok(process) => process,
               Err(_) => {
                  show_status(
                     &app,
                     "転送サービスを起動できません。配布フォルダーを確認して再起動してください。",
                  );
                  return;
               }
            };
         *current = Some(process.clone());
         process
      };
      if state.closing.load(Ordering::Acquire) {
         process.shutdown();
         return;
      }
      let credential = state.credential.lock().ok().and_then(|value| value.clone());
      let initialization = json!({
         "storageDir": state.data_root.join("storage"),
         "receiveDir": state.data_root.join("receive"),
         "staticRoot": state.executable_root.join("web"),
         "version": env!("CARGO_PKG_VERSION"),
         "serviceRestarts": launches,
         "credential": credential,
      });
      launches += 1;
      let initialized = (|| {
         let _gate = state
            .snapshot_gate
            .lock()
            .map_err(|_| "Unable to initialize")?;
         let snapshot: Snapshot =
            serde_json::from_value(process.call("initialize", initialization)?)
               .map_err(|_| "Invalid initialization response".to_string())?;
         let url = runtime_url(&snapshot.runtime)?;
         state.apply_snapshot(snapshot)?;
         let mut capability = CapabilityBuilder::new(format!("service-{launches}"))
            .window("main")
            .webview("main")
            .local(false)
            .remote(capability_remote_url(&url));
         for command in ALLOWED_COMMANDS {
            capability = capability.permission(format!("allow-{command}"));
         }
         app.add_capability(capability)
            .map_err(|_| "Unable to authorize the local window".to_string())?;
         *state
            .allowed_url
            .write()
            .map_err(|_| "Unable to update origin")? = Some(url.clone());
         if state.closing.load(Ordering::Acquire) {
            return Err("Closing".into());
         }
         let window = app.get_webview_window("main").ok_or("Window closed")?;
         window
            .navigate(url)
            .map_err(|_| "Unable to load local window".to_string())?;
         Ok::<(), String>(())
      })();
      if let Err(error) = initialized {
         process.shutdown();
         state.clear_service();
         if state.closing.load(Ordering::Acquire) {
            return;
         }
         if error == CREDENTIAL_REJECTED {
            show_status(&app, CREDENTIAL_REJECTED);
            return;
         }
         failures += 1;
         if failures >= 3 {
            show_status(
               &app,
               "転送ルームを準備できませんでした。アプリを閉じてから再起動してください。",
            );
            return;
         }
         thread::sleep(Duration::from_millis(500));
         continue;
      }
      failures = 0;
      let mut last_snapshot = Instant::now();
      while process.is_running() && !state.closing.load(Ordering::Acquire) {
         thread::sleep(Duration::from_millis(200));
         if last_snapshot.elapsed() >= Duration::from_secs(3) {
            let _ = state.snapshot("bootstrap");
            last_snapshot = Instant::now();
         }
      }
      if state.closing.load(Ordering::Acquire) {
         return;
      }
      process.shutdown();
      state.clear_service();
      if let Some(window) = app.get_webview_window("main") {
         let _ = window.navigate(Url::parse(LOADING_URL).expect("Static loading URL"));
      }
      if launches >= 10 {
         show_status(
            &app,
            "転送サービスの再起動が続いています。アプリを閉じてから再起動してください。",
         );
         return;
      }
      thread::sleep(Duration::from_millis(500));
   }
}

fn begin_shutdown(app: AppHandle, state: Arc<HostState>) {
   if state.closing.swap(true, Ordering::AcqRel) {
      return;
   }
   state.power.set(false);
   if let Some(window) = app.get_webview_window("main") {
      let _ = window.hide();
   }
   thread::spawn(move || {
      let service = state.service.lock().ok().and_then(|value| value.clone());
      if let Some(service) = service {
         service.shutdown();
      }
      state.clear_service();
      app.exit(0);
   });
}

fn show_status(app: &AppHandle, message: &str) {
   let state = app.state::<Arc<HostState>>();
   if let Ok(mut current) = state.loading_message.lock() {
      *current = message.into();
   }
   if let Some(window) = app.get_webview_window("main") {
      update_status(&window, message);
   }
}

fn update_status(window: &WebviewWindow, message: &str) {
   if let Ok(message) = serde_json::to_string(message) {
      let _ = window.eval(&format!(
         "document.getElementById('status')?.replaceChildren({message});"
      ));
   }
}

fn emit_dom(window: &WebviewWindow, event: &str, detail: &Value) {
   if let (Ok(event), Ok(detail)) = (serde_json::to_string(event), serde_json::to_string(detail)) {
      let _ = window.eval(&format!(
         "window.dispatchEvent(new CustomEvent({event},{{detail:{detail}}}));"
      ));
   }
}

async fn blocking<T: Send + 'static>(
   operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
   tauri::async_runtime::spawn_blocking(operation)
      .await
      .map_err(|_| "処理を完了できませんでした。".to_string())?
}

#[tauri::command]
async fn room_bootstrap(
   window: WebviewWindow,
   state: State<'_, Arc<HostState>>,
) -> Result<Bootstrap, String> {
   authorize(&window, &state)?;
   let state = state.inner().clone();
   blocking(move || state.snapshot("bootstrap")).await
}

#[tauri::command]
async fn reset_room(
   window: WebviewWindow,
   state: State<'_, Arc<HostState>>,
) -> Result<Bootstrap, String> {
   authorize(&window, &state)?;
   let state = state.inner().clone();
   blocking(move || state.snapshot("reset-room")).await
}

#[tauri::command]
async fn choose_files(
   window: WebviewWindow,
   state: State<'_, Arc<HostState>>,
) -> Result<Option<Value>, String> {
   authorize(&window, &state)?;
   let state = state.inner().clone();
   blocking(move || {
      let paths = rfd::FileDialog::new()
         .set_title("共有するファイルを選択")
         .set_parent(&window)
         .pick_files();
      match paths {
         Some(paths) if !paths.is_empty() => add_paths(&state, paths).map(Some),
         _ => Ok(None),
      }
   })
   .await
}

fn add_paths(state: &HostState, paths: Vec<PathBuf>) -> Result<Value, String> {
   if paths.len() > 256 {
      return Err("一度に選べるファイルは 256 件までです。".into());
   }
   let _gate = state
      .snapshot_gate
      .lock()
      .map_err(|_| "転送ルームを確認できません。".to_string())?;
   let client = state.client()?;
   let snapshot: Snapshot = serde_json::from_value(client.call("bootstrap", Value::Null)?)
      .map_err(|_| "転送ルームの応答が正しくありません。".to_string())?;
   state.apply_snapshot(snapshot)?;
   let mut files = Vec::new();
   for path in paths {
      let metadata =
         fs::metadata(&path).map_err(|_| "選択したファイルを読み取れません。".to_string())?;
      if !path.is_absolute() || !metadata.is_file() {
         return Err("通常のファイルを選択してください。".into());
      }
      let name = path
         .file_name()
         .ok_or("ファイル名を確認できません。")?
         .to_string_lossy();
      let modified = metadata
         .modified()
         .map_err(|_| "ファイルの更新時刻を確認できません。".to_string())?
         .duration_since(UNIX_EPOCH)
         .map_err(|_| "ファイルの更新時刻が正しくありません。".to_string())?
         .as_millis();
      files.push(json!({"path": path, "name": name, "type": "application/octet-stream", "size": metadata.len(), "lastModified": modified as u64}));
   }
   client.call("add-files", json!({"files": files}))
}

#[tauri::command]
async fn get_diagnostics(
   window: WebviewWindow,
   state: State<'_, Arc<HostState>>,
) -> Result<Value, String> {
   authorize(&window, &state)?;
   let state = state.inner().clone();
   blocking(move || state.client()?.call("diagnostics", Value::Null)).await
}

#[tauri::command]
async fn show_received_file(
   window: WebviewWindow,
   state: State<'_, Arc<HostState>>,
   room_id: String,
   item_id: String,
) -> Result<(), String> {
   authorize(&window, &state)?;
   if room_id.len() > 128 || item_id.len() > 128 {
      return Err("ファイルの指定が正しくありません。".into());
   }
   let state = state.inner().clone();
   blocking(move || {
      let result = state.client()?.call(
         "completed-path",
         json!({"roomId": room_id, "itemId": item_id}),
      )?;
      let path = PathBuf::from(result.as_str().ok_or("ファイルの場所を確認できません。")?);
      platform::show_file(&path)
   })
   .await
}

#[tauri::command]
async fn open_receive_folder(
   window: WebviewWindow,
   state: State<'_, Arc<HostState>>,
) -> Result<(), String> {
   authorize(&window, &state)?;
   let path = state.data_root.join("receive");
   blocking(move || platform::open_folder(&path)).await
}

#[tauri::command]
async fn open_log_folder(
   window: WebviewWindow,
   state: State<'_, Arc<HostState>>,
) -> Result<(), String> {
   authorize(&window, &state)?;
   let path = state.data_root.join("storage/logs");
   blocking(move || platform::open_folder(&path)).await
}

#[tauri::command]
async fn resize_to_content(
   window: WebviewWindow,
   state: State<'_, Arc<HostState>>,
   height: f64,
) -> Result<(), String> {
   authorize(&window, &state)?;
   if !height.is_finite() {
      return Err("画面サイズが正しくありません。".into());
   }
   let max = window
      .current_monitor()
      .ok()
      .flatten()
      .map(|monitor| {
         ((monitor.size().height as f64 / monitor.scale_factor()) - 80.0).clamp(340.0, 780.0)
      })
      .unwrap_or(780.0);
   window
      .set_size(LogicalSize::new(300.0, height.round().clamp(340.0, max)))
      .map_err(|_| "画面サイズを変更できません。".to_string())
}

#[tauri::command]
async fn set_transfer_active(
   window: WebviewWindow,
   state: State<'_, Arc<HostState>>,
   active: bool,
) -> Result<(), String> {
   authorize(&window, &state)?;
   state.renderer_active.store(active, Ordering::Release);
   state.update_power();
   Ok(())
}

#[cfg(test)]
mod tests {
   use super::{capability_remote_url, runtime_url, Runtime};
   use std::path::PathBuf;
   use tauri::utils::acl::RemoteUrlPattern;

   fn runtime(local_url: &str, port: u16) -> Runtime {
      Runtime {
         port,
         local_url: local_url.into(),
         receive_dir: PathBuf::new(),
         log_dir: PathBuf::new(),
      }
   }

   #[test]
   fn native_origin_uses_only_the_current_loopback_port_and_app_path() {
      let url = runtime_url(&runtime("http://127.0.0.1:8787", 8787)).expect("Loopback URL");
      assert_eq!(url.as_str(), "http://127.0.0.1:8787/app");
      assert!(runtime_url(&runtime("http://127.0.0.1:8787", 8788)).is_err());
   }

   #[test]
   fn native_origin_rejects_lan_credentials_and_navigation_suffixes() {
      for url in [
         "http://192.0.2.1:8787",
         "http://localhost:8787",
         "https://127.0.0.1:8787",
         "http://user:password@127.0.0.1:8787",
         "http://127.0.0.1:8787/app",
         "http://127.0.0.1:8787?target=app",
         "http://127.0.0.1:8787#app",
      ] {
         assert!(
            runtime_url(&runtime(url, 8787)).is_err(),
            "Rejected URL: {url}"
         );
      }
   }

   #[test]
   fn ipc_scope_accepts_both_fetch_origin_and_postmessage_document_url() {
      let url = runtime_url(&runtime("http://127.0.0.1:8787", 8787)).unwrap();
      let scope: RemoteUrlPattern = capability_remote_url(&url).parse().unwrap();
      assert!(scope.test(&"http://127.0.0.1:8787/".parse().unwrap()));
      assert!(scope.test(&url));
   }

   #[test]
   fn ipc_scope_keeps_the_exact_loopback_host_scheme_and_port() {
      let url = runtime_url(&runtime("http://127.0.0.1:8787", 8787)).unwrap();
      let scope: RemoteUrlPattern = capability_remote_url(&url).parse().unwrap();
      for other in [
         "http://127.0.0.1:8788/app",
         "http://192.0.2.1:8787/app",
         "http://localhost:8787/app",
         "https://127.0.0.1:8787/app",
         "http://127.0.0.1.example.test:8787/app",
         "http://tauri.localhost/",
      ] {
         assert!(
            !scope.test(&other.parse().unwrap()),
            "Rejected IPC origin: {other}"
         );
      }
   }
}
