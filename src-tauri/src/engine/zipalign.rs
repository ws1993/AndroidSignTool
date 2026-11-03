use std::path::{Path, PathBuf};
use std::process::Command;

use super::proc::run_and_stream;

/// 执行 zipalign：`zipalign -f -p 4 <in> <out>`
pub fn align(
    zipalign_exe: &Path,
    input: &Path,
    output: &Path,
    emit: &mut dyn FnMut(&str),
) -> Result<(), String> {
    let mut cmd = Command::new(zipalign_exe);
    cmd.arg("-f").arg("-p").arg("4").arg(input).arg(output);
    emit(&format!("$ zipalign -f -p 4 {} {}", input.display(), output.display()));
    let (code, _) = run_and_stream(cmd, &mut *emit)?;
    if code != 0 {
        return Err(format!("zipalign 退出码 {code}"));
    }
    emit("[zipalign] 字节对齐完成");
    Ok(())
}

#[allow(dead_code)]
pub fn check(
    zipalign_exe: &Path,
    apk: &PathBuf,
    emit: &mut dyn FnMut(&str),
) -> Result<bool, String> {
    let mut cmd = Command::new(zipalign_exe);
    cmd.arg("-c").arg("4").arg(apk);
    let (code, _) = run_and_stream(cmd, &mut *emit)?;
    Ok(code == 0)
}
