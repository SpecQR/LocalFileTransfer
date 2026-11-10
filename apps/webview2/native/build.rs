fn main() {
   if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
      return;
   }

   const COMMANDS: &[&str] = &[
      "room_bootstrap",
      "choose_files",
      "reset_room",
      "get_diagnostics",
      "show_received_file",
      "open_receive_folder",
      "open_log_folder",
      "resize_to_content",
      "set_transfer_active",
   ];
   let manifest = tauri_build::AppManifest::new().commands(COMMANDS);
   let icon =
      std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo output directory"))
         .join("preview.ico");
   std::fs::write(&icon, icon_bytes()).expect("Unable to generate the application icon");
   let windows = tauri_build::WindowsAttributes::new()
      .window_icon_path(icon)
      .static_vc_runtime(true);
   tauri_build::try_build(
      tauri_build::Attributes::new()
         .app_manifest(manifest)
         .windows_attributes(windows),
   )
   .expect("WebView2 preview build configuration is invalid");
}

// Generate the small two-arrow icon in the build output, keeping the source tree textual.
fn icon_bytes() -> Vec<u8> {
   const SIDE: u32 = 32;
   const IMAGE_BYTES: u32 = 40 + SIDE * SIDE * 4 + SIDE * 4;
   let mut bytes = Vec::with_capacity((22 + IMAGE_BYTES) as usize);
   for value in [0u16, 1, 1] {
      bytes.extend(value.to_le_bytes());
   }
   bytes.extend([SIDE as u8, SIDE as u8, 0, 0]);
   for value in [1u16, 32] {
      bytes.extend(value.to_le_bytes());
   }
   bytes.extend(IMAGE_BYTES.to_le_bytes());
   bytes.extend(22u32.to_le_bytes());
   for value in [40u32, SIDE, SIDE * 2] {
      bytes.extend(value.to_le_bytes());
   }
   for value in [1u16, 32] {
      bytes.extend(value.to_le_bytes());
   }
   for value in [0u32, SIDE * SIDE * 4, 0, 0, 0, 0] {
      bytes.extend(value.to_le_bytes());
   }
   for y in (0..SIDE as i32).rev() {
      for x in 0..SIDE as i32 {
         let right = ((6..=21).contains(&x) && (9..=12).contains(&y))
            || ((20..=26).contains(&x) && (y - 10).abs() <= 26 - x);
         let left = ((10..=25).contains(&x) && (20..=23).contains(&y))
            || ((5..=11).contains(&x) && (y - 21).abs() <= x - 5);
         bytes.extend(if right || left {
            [0xf4, 0xfa, 0xf7, 0xff]
         } else {
            [0x48, 0x6c, 0x28, 0xff]
         });
      }
   }
   bytes.resize((22 + IMAGE_BYTES) as usize, 0);
   bytes
}
