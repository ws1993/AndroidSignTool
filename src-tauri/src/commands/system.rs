use std::path::Path;
use std::process::Command;

/// 在资源管理器中打开目录；传入文件时选中该文件。
/// 只接受本机已存在的路径，不接受任意 URL，避免前端误用。
#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    let p = path.trim();
    if p.is_empty() {
        return Err("路径为空".to_string());
    }
    let target = Path::new(p);
    if !target.exists() {
        return Err(format!("路径不存在：{p}"));
    }
    let arg = if target.is_dir() {
        p.to_string()
    } else {
        format!("/select,{p}")
    };
    Command::new("explorer.exe")
        .arg(arg)
        .spawn()
        .map_err(|e| format!("打开资源管理器失败: {e}"))?;
    Ok(())
}

/// 测试代理地址连通性（TCP 握手探测与耗时统计）
#[tauri::command]
pub fn test_proxy(url: String) -> Result<String, String> {
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::{Duration, Instant};

    let raw = url.trim();
    if raw.is_empty() {
        return Err("代理地址不能为空".to_string());
    }

    let target = if let Some(idx) = raw.find("://") {
        &raw[idx + 3..]
    } else {
        raw
    };

    let host_port = target.split('/').next().unwrap_or(target);

    let (host, port) = if let Some((h, p)) = host_port.rsplit_once(':') {
        let p_num: u16 = p.parse().map_err(|_| format!("无效的端口号: {p}"))?;
        (h, p_num)
    } else {
        (host_port, 80u16)
    };

    let addr_str = format!("{host}:{port}");
    let start = Instant::now();

    let addrs = addr_str
        .to_socket_addrs()
        .map_err(|e| format!("解析代理主机「{host}」失败: {e}"))?;

    let mut last_err = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, Duration::from_millis(2500)) {
            Ok(stream) => {
                let _ = stream.set_nodelay(true);
                let elapsed = start.elapsed().as_millis();
                return Ok(format!("代理端口连通正常（{addr_str}，握手耗时 {elapsed}ms）"));
            }
            Err(e) => {
                last_err = Some(e);
            }
        }
    }

    Err(format!(
        "连接代理失败「{addr_str}」: {}",
        last_err.map(|e| e.to_string()).unwrap_or_else(|| "连接超时".to_string())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_proxy_invalid_input() {
        assert!(test_proxy("".to_string()).is_err());
        assert!(test_proxy("   ".to_string()).is_err());
    }
}

