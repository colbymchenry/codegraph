//! Node-ID generation — MUST produce byte-identical output to
//! `generateNodeId` in `src/extraction/tree-sitter-helpers.ts`:
//!
//!   `${kind}:${sha256(`${filePath}:${kind}:${name}:${line}`).hex[0..32]}`
//! NodeIdAllocator appends `:<UTF-16 column>` only for later, distinct source
//! positions sharing that legacy ID within an extraction.
//!
//! and the file-node special case in `TreeSitterExtractor.extract()`:
//!
//!   `file:${filePath}`
//!
//! Node identity is how the wasm path and the kernel path agree on the same
//! graph — a drift here breaks every edge. Pinned by the node-id parity test
//! in `__tests__/kernel-scaffold.test.ts`.

use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// Per-extraction collision handling, matching NodeIdAllocator in the wasm path.
#[derive(Default)]
pub struct NodeIdAllocator {
    first_columns: HashMap<String, u32>,
}

impl NodeIdAllocator {
    pub fn generate(
        &mut self,
        file_path: &str,
        kind: &str,
        name: &str,
        line: u32,
        column: u32,
    ) -> String {
        let id = node_id(file_path, kind, name, line);
        // Zero-based UTF-16 column (util::col16), never tree-sitter's byte column.
        let first_column = self.first_columns.entry(id.clone()).or_insert(column);
        if *first_column == column {
            id
        } else {
            format!("{id}:{column}")
        }
    }
}

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
    fn collision_only_identity_vectors() {
        let mut ids = NodeIdAllocator::default();
        let base = "function:bfb15544fed707794274a5c61006ea7b";
        for (column, expected) in [
            (2, base.to_string()),
            (24, format!("{base}:24")),
            (48, format!("{base}:48")),
            (24, format!("{base}:24")),
            (2, base.to_string()),
        ] {
            assert_eq!(
                ids.generate("src/a.ts", "function", "foo", 3, column),
                expected
            );
        }
        assert_eq!(
            ids.generate("src/b.ts", "function", "foo", 3, 24),
            node_id("src/b.ts", "function", "foo", 3)
        );
        assert_eq!(
            NodeIdAllocator::default().generate("src/a.ts", "function", "foo", 3, 24),
            base
        );
    }

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
