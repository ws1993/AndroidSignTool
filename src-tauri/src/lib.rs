mod commands;
mod engine;
mod store;
mod tool_paths;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::sign::sign_apk,
            commands::sign::list_strategies,
            commands::sign::check_tools,
            commands::profile::list_profiles,
            commands::profile::get_profile,
            commands::profile::probe_keystore,
            commands::profile::save_profile,
            commands::profile::delete_profile,
            commands::keystore::generate_keystore,
            commands::keystore::keystore_exists,
            commands::apkinfo::apk_info,
            commands::history::history_list,
            commands::history::history_clear,
            commands::history::history_export,
            commands::history::data_paths,
            commands::system::open_in_explorer,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
