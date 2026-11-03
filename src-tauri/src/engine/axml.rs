//! 极简 AXML（Android 二进制 XML）解析器：只需要从 AndroidManifest.xml 抽取
//! package / versionCode / versionName / minSdkVersion / targetSdkVersion。
//!
//! 二进制结构：文件头 (type 0x0003, headerSize 8)
//!   → StringPool chunk (type 0x0001)
//!   → 资源映射 (type 0x0180)
//!   → start/end namespace / start element (0x0102)

use std::path::Path;

fn rd_u16(d: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([d[o], d[o + 1]])
}
fn rd_u32(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([d[o], d[o + 1], d[o + 2], d[o + 3]])
}

/// 解析 StringPool（type 0x0001，UCS-2 与 UTF-8 两种编码都支持）
fn string_pool(data: &[u8], chunk_start: usize) -> Result<Vec<String>, String> {
    // header: type u16, headerSize u16, size u32, stringCount u32, styleOffCount u32,
    // flags u32, stringsStart u32, stylesStart u32 → headerSize 0x1C
    let header_size = rd_u16(data, chunk_start + 2) as usize;
    if header_size < 28 || chunk_start + header_size > data.len() {
        return Err("string pool chunk 头长度异常".into());
    }
    // ResStringPool_header 相对 chunk 起始：
    //   stringCount@+8 styleCount@+12 flags@+16 stringsStart@+20 stylesStart@+24
    // 字符串偏移表紧跟在 headerSize 之后，字符串数据基址 = chunk + stringsStart。
    let string_count = rd_u32(data, chunk_start + 8).min(65_536) as usize;
    let flags = rd_u32(data, chunk_start + 16);
    let strings_start = chunk_start + rd_u32(data, chunk_start + 20) as usize;
    let offsets_base = chunk_start + header_size;

    let utf8 = flags & 0x100 != 0;
    let mut strings = Vec::with_capacity(string_count);
    for i in 0..string_count {
        let off = strings_start + rd_u32(data, offsets_base + i * 4) as usize;
        if off >= data.len() {
            strings.push(String::new());
            continue;
        }
        let s = if utf8 {
            // u8len h1..h16 变长, 后接 utf8 长度变长再接字节流
            let (len, o) = decode_utf8_len(data, off);
            let (_skip_len, o2) = decode_utf8_len(data, o);
            let end = o2 + len;
            let le = data.get(o2..end.min(data.len())).unwrap_or(&[]);
            String::from_utf8_lossy(le).to_string()
        } else {
            // u16 len (h16 可能带 0x8000 高位表示大长度)
            let mut len = rd_u16(data, off) as usize;
            let mut pos = off + 2;
            if len & 0x8000 != 0 {
                let hi = rd_u16(data, pos) as usize;
                pos += 2;
                len = ((len & 0x7FFF) << 16) | hi;
            }
            let max = (pos + len * 2).min(data.len());
            let mut s = String::with_capacity(len);
            let mut i = pos;
            while i + 1 < max {
                let u = u16::from_le_bytes([data[i], data[i + 1]]);
                if u == 0 {
                    break;
                }
                s.push(char::from_u32(u as u32).unwrap_or('\u{fffd}'));
                i += 2;
            }
            s
        };
        strings.push(s);
    }
    Ok(strings)
}

fn decode_utf8_len(data: &[u8], off: usize) -> (usize, usize) {
    let b0 = data[off] as usize;
    if b0 & 0x80 == 0 {
        (b0 & 0x7F, off + 1)
    } else {
        if off + 1 < data.len() {
            (((b0 & 0x7F) << 8) | data[off + 1] as usize, off + 2)
        } else {
            (b0 & 0x7F, off + 1)
        }
    }
}

const TYPE_REFERENCE: u8 = 0x01;
const TYPE_STRING: u8 = 0x03;
const TYPE_INT_DEC: u8 = 0x10;
const TYPE_INT_HEX: u8 = 0x11;
const TYPE_BOOLEAN: u8 = 0x12;

#[derive(Debug, Clone)]
pub struct AxAttr {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone)]
pub struct AxElement {
    pub name: String,
    pub attrs: Vec<AxAttr>,
}

impl AxElement {
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|a| a.name == name).map(|a| a.value.as_str())
    }
}

/// 从 AXML 字节流提取 element 事件（start-only 列表）。
pub fn parse(axml: &[u8]) -> Result<Vec<AxElement>, String> {
    if axml.len() < 8 {
        return Err("AXML 数据过短".into());
    }
    let mut elements = Vec::new();
    let mut stack: Vec<Option<AxElement>> = Vec::new();
    let mut strings: Vec<String> = Vec::new();

    // 整个文件是 type=0x0003 的容器 chunk，子 chunk 从它的 headerSize(=8) 处开始。
    // 若从偏移 0 起按 size 前进，第一个 chunk 就会一次跳过整个文件（曾导致 0 个 chunk 被解析）。
    let mut end = axml.len();
    let mut pos = 0usize;
    if rd_u16(axml, 0) == 0x0003 {
        end = (rd_u32(axml, 4) as usize).min(axml.len());
        pos = (rd_u16(axml, 2) as usize).max(8);
    }

    while pos + 8 <= end {
        let ctype = rd_u16(axml, pos);
        let header_size = rd_u16(axml, pos + 2) as usize;
        let size = rd_u32(axml, pos + 4) as usize;
        if size < 8 {
            break;
        }
        match ctype {
            0x0001 => {
                strings = string_pool(axml, pos)?;
            }
            0x0102 => {
                // START_ELEMENT。build-tools 35 的 aapt 与 aapt2 实测一致：name 位于
                // headerSize+4（两者之间夹着一个恒为 -1 的 u32），attributeStart/Size/Count
                // 紧随其后；属性区基址 = name 字段位置 + attributeStart，步长 = attributeSize(=20)。
                // 为兼容把 name 直接放在 headerSize 处的历史写入器，按候选偏移择优判定。
                let chunk_end = (pos + size).min(end);
                let body = pos + header_size.max(8);
                let mut picked: Option<(usize, usize, usize, usize)> = None;
                for name_at in [body + 4, body] {
                    if name_at + 10 > chunk_end {
                        continue;
                    }
                    let name_ref = rd_u32(axml, name_at);
                    let attr_start = rd_u16(axml, name_at + 4) as usize;
                    let stride = rd_u16(axml, name_at + 6) as usize;
                    let count = rd_u16(axml, name_at + 8) as usize;
                    if count > 1024 || !(16..=64).contains(&stride) {
                        continue;
                    }
                    let ab = name_at + attr_start;
                    // 尾部边界按「最后一条属性记录占 16 字节」判定：aapt 声明的 chunk size
                    // 不含最后一条之后的 4 字节补齐，若按 count*stride 计算会把整段元素误判越界丢弃
                    // （表现为 manifest 元素被跳过、package/versionCode 全为 None）。
                    let attrs_end = if count == 0 {
                        ab
                    } else {
                        ab + (count - 1) * stride + 16
                    };
                    if attrs_end > chunk_end + stride {
                        continue;
                    }
                    // 属性记录里 typedValue.size 恒为 8，用它判定候选偏移是否正确
                    let ok = if count == 0 {
                        name_ref == 0xFFFF_FFFF || (name_ref as usize) < strings.len()
                    } else {
                        rd_u16(axml, ab + 8) == 8
                    };
                    if ok {
                        picked = Some((name_ref as usize, ab, stride, count));
                        break;
                    }
                }
                if let Some((name_ref, ab, stride, attr_count)) = picked {
                    let name = strings.get(name_ref).cloned().unwrap_or_default();
                    let mut attrs = Vec::with_capacity(attr_count);
                    for k in 0..attr_count {
                        let at = ab + k * stride;
                        if at + 16 > axml.len() {
                            break;
                        }
                        let an_ref = rd_u32(axml, at) as usize;
                        let raw_ref = rd_u32(axml, at + 4);
                        let data_type = axml[at + 11];
                        let data = rd_u32(axml, at + 12);
                        let aname = strings.get(an_ref).cloned().unwrap_or_default();
                        // rawValue != -1 时优先取原始字符串（如 "1.0"），否则按 data_type 解码
                        let value: String = if raw_ref != 0xFFFF_FFFF {
                            strings.get(raw_ref as usize).cloned().unwrap_or_default()
                        } else {
                            match data_type {
                                TYPE_STRING => strings
                                    .get(data as usize)
                                    .cloned()
                                    .unwrap_or_default(),
                                TYPE_INT_DEC => (data as i32).to_string(),
                                TYPE_INT_HEX => format!("0x{data:x}"),
                                TYPE_REFERENCE => format!("0x{data:08x}"),
                                TYPE_BOOLEAN => (data != 0).to_string(),
                                _ => String::new(),
                            }
                        };
                        attrs.push(AxAttr { name: aname, value });
                    }
                    let el = AxElement { name, attrs };
                    stack.push(Some(el));
                    if let Some(Some(el)) = stack.last() {
                        elements.push(el.clone());
                    }
                }
            }
            0x0103 => {
                stack.pop();
            }
            _ => {}
        }
        pos += size;
    }
    Ok(elements)
}

pub struct ManifestInfo {
    pub package: Option<String>,
    pub version_code: Option<String>,
    pub version_name: Option<String>,
    pub min_sdk: Option<String>,
    pub target_sdk: Option<String>,
}

/// 从 zip 中读取 AndroidManifest.xml 并提取关键字段。
pub fn read_manifest_from_zip(apk_path: &Path) -> Result<ManifestInfo, String> {
    let f = std::fs::File::open(apk_path).map_err(|e| format!("打开 APK 失败: {e}"))?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| format!("解析 APK(zip) 失败: {e}"))?;
    let entry = zip
        .by_name("AndroidManifest.xml")
        .map_err(|e| format!("找不到 AndroidManifest.xml: {e}"))?;
    let mut buf = Vec::new();
    std::io::Read::read_to_end(&mut std::io::BufReader::new(std::io::Read::take(entry, 8 * 1024 * 1024)), &mut buf)
        .map_err(|e| format!("读取 manifest 流失败: {e}"))?;
    let elements = parse(&buf)?;
    let mut info = ManifestInfo {
        package: None,
        version_code: None,
        version_name: None,
        min_sdk: None,
        target_sdk: None,
    };
    for el in &elements {
        match el.name.as_str() {
            "manifest" => {
                info.package = el.attr("package").map(|s| s.to_string());
                info.version_code = el.attr("versionCode").map(|s| s.to_string());
                info.version_name = el.attr("versionName").map(|s| s.to_string());
            }
            "uses-sdk" => {
                info.min_sdk.get_or_insert_with(|| el.attr("minSdkVersion").unwrap_or_default().to_string());
                info.target_sdk
                    .get_or_insert_with(|| el.attr("targetSdkVersion").unwrap_or_default().to_string());
            }
            _ => {}
        }
    }
    Ok(info)
}
