//! Windows DPAPI（CryptProtectData / CryptUnprotectData）封装。
//!
//! 密码字段以当前 Windows 用户上下文加密后落盘：拷贝到别的机器/别的用户账户无法解密。

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};

fn protect_bytes(plain: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: plain.len() as u32,
        pbData: plain.as_ptr() as *mut u8,
    };
    let mut out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            0,
            &mut out,
        )
        .map_err(|e| format!("DPAPI 加密失败: {e}"))?;
    }
    let slice = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
    unsafe {
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut core::ffi::c_void)));
    }
    if slice.is_empty() {
        return Err("DPAPI 加密输出为空".into());
    }
    Ok(slice)
}

fn unprotect_bytes(blob: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: blob.len() as u32,
        pbData: blob.as_ptr() as *mut u8,
    };
    let mut out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    unsafe {
        CryptUnprotectData(&input, None, None, None, None, 0, &mut out)
            .map_err(|e| format!("DPAPI 解密失败（配置可能属于其他 Windows 用户）: {e}"))?;
    }
    let slice = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
    unsafe {
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut core::ffi::c_void)));
    }
    Ok(slice)
}

/// 明文 → DPAPI blob → base64（落盘形态）
pub fn protect_text(plain: &str) -> Result<String, String> {
    let mut u16s: Vec<u8> = Vec::with_capacity((plain.len() + 1) * 2);
    for u in plain.encode_utf16() {
        u16s.extend_from_slice(u.to_le_bytes().as_slice());
    }
    u16s.extend_from_slice(&[0, 0]);
    Ok(B64.encode(protect_bytes(&u16s)?))
}

/// base64 → DPAPI blob → 明文
pub fn unprotect_text(enc: &str) -> Result<String, String> {
    let blob = B64
        .decode(enc.as_bytes())
        .map_err(|e| format!("密码字段落盘数据损坏: {e}"))?;
    let bytes = unprotect_bytes(&blob)?;
    let u16s: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .take_while(|&u| u != 0)
        .collect();
    String::from_utf16(&u16s).map_err(|_| "密码字段解码失败".to_string())
}
