use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::Path;

use super::profile_store::now_str;

pub struct NewRecord<'a> {
    pub apk: &'a str,
    pub output: &'a str,
    pub strategy: &'a str,
    pub ok: bool,
    pub error: Option<&'a str>,
    pub duration_ms: u64,
    pub cert: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: i64,
    pub created_at: String,
    pub apk: String,
    pub output: String,
    pub strategy: String,
    pub ok: bool,
    pub error: Option<String>,
    pub duration_ms: i64,
    pub cert: Option<String>,
}

pub fn open(db: &Path) -> Result<Connection, String> {
    let conn = Connection::open(db).map_err(|e| format!("打开历史数据库失败: {e}"))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sign_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            apk TEXT NOT NULL,
            output TEXT NOT NULL,
            strategy TEXT NOT NULL,
            ok INTEGER NOT NULL,
            error TEXT,
            duration_ms INTEGER NOT NULL,
            cert TEXT
        );",
    )
    .map_err(|e| format!("初始化历史表失败: {e}"))?;
    Ok(conn)
}

pub fn insert(conn: &Connection, r: &NewRecord) -> Result<(), String> {
    conn.execute(
        "INSERT INTO sign_history (created_at, apk, output, strategy, ok, error, duration_ms, cert)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            now_str(),
            r.apk,
            r.output,
            r.strategy,
            r.ok as i64,
            r.error,
            r.duration_ms as i64,
            r.cert
        ],
    )
    .map_err(|e| format!("写入历史记录失败: {e}"))?;
    Ok(())
}

pub fn list(conn: &Connection, limit: i64) -> Result<Vec<Record>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, created_at, apk, output, strategy, ok, error, duration_ms, cert
             FROM sign_history ORDER BY id DESC LIMIT ?1",
        )
        .map_err(|e| format!("查询历史失败: {e}"))?;
    let rows = stmt
        .query_map(params![limit], |row| {
            Ok(Record {
                id: row.get(0)?,
                created_at: row.get(1)?,
                apk: row.get(2)?,
                output: row.get(3)?,
                strategy: row.get(4)?,
                ok: row.get::<_, i64>(5)? != 0,
                error: row.get(6)?,
                duration_ms: row.get(7)?,
                cert: row.get(8)?,
            })
        })
        .map_err(|e| format!("查询历史失败: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取历史行失败: {e}"))
}

pub fn clear(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM sign_history", [])
        .map_err(|e| format!("清空历史失败: {e}"))?;
    Ok(())
}

/// 导出 CSV（带 UTF-8 BOM，Excel 直接可读）
pub fn export_csv(conn: &Connection, path: &Path) -> Result<usize, String> {
    let rows = list(conn, 100_000)?;
    let mut buf = String::from("\u{feff}时间,源APK,输出APK,策略,结果,耗时ms,证书摘要,错误\n");
    let esc = |s: &str| -> String {
        if s.contains(',') || s.contains('"') || s.contains('\n') {
            format!("\"{}\"", s.replace('"', "\"\""))
        } else {
            s.to_string()
        }
    };
    for r in &rows {
        buf.push_str(&format!(
            "{},{},{},{},{},{},{},{}\n",
            esc(&r.created_at),
            esc(&r.apk),
            esc(&r.output),
            esc(&r.strategy),
            if r.ok { "成功" } else { "失败" },
            r.duration_ms,
            esc(r.cert.as_deref().unwrap_or("")),
            esc(r.error.as_deref().unwrap_or(""))
        ));
    }
    std::fs::write(path, buf).map_err(|e| format!("写出 CSV 失败: {e}"))?;
    Ok(rows.len())
}
