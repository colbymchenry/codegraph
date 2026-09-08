//! Node-ID generation — MUST produce byte-identical output to
//! `generateNodeId` in `src/extraction/tree-sitter-helpers.ts`:
//!
//!   `${kind}:${sha256(`${filePath}:${kind}:${name}:${line}`).hex[0..32]}`
//!
//! and the file-node special case in `TreeSitterExtractor.extract()`:
//!
//!   `file:${filePath}`
//!
//! Node identity is how the wasm path and the kernel path agree on the same
//! graph — a drift here breaks every edge. Pinned by the node-id parity test
//! in `__tests__/kernel-scaffold.test.ts`.

use sha2::{Digest, Sha256};

pub fn node_id(file_path: &str, kind: &str, name: &str, line: u32) -> String {
    let mut hasher = Sha256::new();
    hasher.update(file_path.as_bytes());
    hasher.update(b":");
    hasher.update(kind.as_bytes());
    hasher.update(b":");
    hasher.update(name.as_bytes());
    hasher.update(b":");
    hasher.update(line.to_string().as_bytes());
    let digest = hasher.finalize();
    // 32 hex chars = first 16 bytes.
    let mut hex = String::with_capacity(kind.len() + 1 + 32);
    hex.push_str(kind);
    hex.push(':');
    for b in &digest[..16] {
        hex.push_str(&format!("{b:02x}"));
    }
    hex
}

pub fn file_node_id(file_path: &str) -> String {
    format!("file:{file_path}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_known_ts_output() {
        // Pinned vector: node -e "crypto.createHash('sha256')
        //   .update('src/a.ts:function:foo:3').digest('hex').substring(0,32)"
        assert_eq!(
            node_id("src/a.ts", "function", "foo", 3),
            "function:bfb15544fed707794274a5c61006ea7b"
        );
    }
}
