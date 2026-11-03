//! 子进程执行封装：CREATE_NO_WINDOW、stdout/stderr 实时回调、日志脱敏。

use std::io::Read;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use windows::Win32::Globalization::{
    GetACP, MultiByteToWideChar, MULTI_BYTE_TO_WIDE_CHAR_FLAGS,
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub type Dyad<'a> = Box<dyn Fn(&str, bool) + 'a>;

/// 对一行输出做脱敏：把任何 pass:xxx / storepass 值打码
pub fn redact(line: &str) -> String {
    let mut out = line.to_string();
    for key in [
        "storepass", "keypass", "ks-pass", "ks-key-pass", "-pass", "pass:",
    ] {
        while let Some(idx) = out.find(key) {
            match out[idx..].find(char::is_whitespace) {
                Some(rel_end) if rel_end > key.len() => {
                    out.replace_range(idx + key.len()..idx + rel_end, "***");
                }
                _ if key.contains(':') => {
                    // 行尾的 pass:xxx
                    let end = out.len();
                    if end > idx + key.len() {
                        out.replace_range(idx + key.len()..end, "***");
                    } else {
                        break;
                    }
                    break;
                }
                _ => break,
            }
        }
    }
    out
}

/// ANSI 代码页（中文 Windows 上是 936/GBK），只取一次。
fn ansi_code_page() -> u32 {
    use std::sync::OnceLock;
    static ACP: OnceLock<u32> = OnceLock::new();
    *ACP.get_or_init(|| unsafe { GetACP() })
}

/// 解码子进程输出字节：先按 UTF-8 严格解码（JVM 侧已强制 UTF-8），
/// 失败再回退系统 ANSI 代码页。
///
/// 之前用 `BufReader::read_line` 把管道当 UTF-8 读：一旦遇到 GBK 字节就返回
/// InvalidData，采集线程立刻 break，keytool / zipalign 的整段输出被丢弃——
/// 表现为 `keytool -list` 退出码 0、别名列表却是空的。
fn decode_bytes(buf: &[u8]) -> String {
    match std::str::from_utf8(buf) {
        Ok(s) => s.to_string(),
        Err(_) => ansi_decode(buf),
    }
}

fn ansi_decode(buf: &[u8]) -> String {
    if buf.is_empty() {
        return String::new();
    }
    let cp = ansi_code_page();
    let flags = MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0);
    unsafe {
        let need = MultiByteToWideChar(cp, flags, buf, None);
        if need <= 0 {
            return String::from_utf8_lossy(buf).to_string();
        }
        let mut wide = vec![0u16; need as usize];
        let wrote = MultiByteToWideChar(cp, flags, buf, Some(&mut wide));
        if wrote <= 0 {
            return String::from_utf8_lossy(buf).to_string();
        }
        String::from_utf16_lossy(&wide[..wrote as usize])
    }
}

struct PipeReader;

impl PipeReader {
    /// 按字节读取一路输出、遇 `\n` 切行，逐行解码回传。
    /// 关键：解码失败只影响单行，不会中断整条流。
    fn drain<R: Read>(mut reader: R, out: &Dyad<'_>) {
        let mut buf: Vec<u8> = Vec::with_capacity(4096);
        let mut chunk = [0u8; 4096];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    while let Some(p) = buf.iter().position(|&b| b == b'\n') {
                        let line: Vec<u8> = buf.drain(..=p).collect();
                        emit_line(&line, out);
                    }
                    // 无换行的超长输出兜底刷出，避免无界增长
                    if buf.len() >= 1 << 20 {
                        let owned: Vec<u8> = std::mem::take(&mut buf);
                        emit_line(&owned, out);
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        if !buf.is_empty() {
            emit_line(&buf, out);
        }
    }
}

/// 去掉行尾 \r\n（按字节去，避免先解码再裁切），再解码回传
fn emit_line(raw: &[u8], out: &Dyad<'_>) {
    let mut end = raw.len();
    while end > 0 && matches!(raw[end - 1], b'\n' | b'\r') {
        end -= 1;
    }
    let text = decode_bytes(&raw[..end]);
    out(&text, false);
}

/// 运行一个子进程并实时转发输出（stdout 与 stderr 合流、均视为输出行）。
/// 返回 exit code 与完整输出。
pub fn run_and_stream(
    mut cmd: Command,
    emit: &mut dyn FnMut(&str),
) -> Result<(i32, Vec<String>), String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // Windows 下隐藏控制台
    if !cfg!(debug_assertions) {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动子进程失败: {} ({e})", format_cmdline(&cmd)))?;

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let mut collected: Vec<String> = Vec::new();
    // stdout 在主线程读；stderr 用线程转发到同一个回调
    // 回调本身要求 Sync? 否. 改为: 两个线程分别处理后通过 channel 归并.
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let tx2 = tx.clone();
    let t_out = std::thread::spawn(move || {
        let sink: Dyad<'static> = Box::new(move |l: &str, _| {
            let _ = tx.send(l.to_string());
        });
        PipeReader::drain(stdout, &sink);
    });
    let t_err = std::thread::spawn(move || {
        let sink: Dyad<'static> = Box::new(move |l: &str, _| {
            let _ = tx2.send(l.to_string());
        });
        PipeReader::drain(stderr, &sink);
    });

    for line in rx {
        let red = redact(&line);
        emit(red.as_str());
        collected.push(line);
    }
    let _ = t_out.join();
    let _ = t_err.join();

    let code = child
        .wait()
        .map_err(|e| format!("等待子进程退出失败: {e}"))?
        .code()
        .unwrap_or(-1);
    Ok((code, collected))
}

fn format_cmdline(cmd: &Command) -> String {
    format!("program: {:?}", cmd.get_program())
}

/// 防止 Child 被泄出逃逸（供后续需要 stdio 的场景）
#[allow(dead_code)]
pub fn take_child(mut c: Child) -> Child {
    c.stdin.take();
    c
}
