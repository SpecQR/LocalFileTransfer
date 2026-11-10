#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
mod host;
#[cfg(windows)]
mod platform;
#[cfg(windows)]
mod rpc;

#[cfg(windows)]
fn main() {
   host::run();
}

#[cfg(not(windows))]
fn main() {
   eprintln!("This preview is available for Windows only.");
}
