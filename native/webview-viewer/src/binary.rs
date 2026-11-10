//! Same-origin one-shot binary mailboxes, shared with Wry's protocol callbacks.
use anyhow::{Context, Result, ensure};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
#[derive(Default)]
pub struct Store {
    serial: u64,
    values: HashMap<String, Vec<u8>>,
}
pub type Shared = Arc<Mutex<Store>>;
impl Store {
    pub fn put(&mut self, bytes: Vec<u8>) -> String {
        self.serial += 1;
        let key = format!("host-{}", self.serial);
        self.values.insert(key.clone(), bytes);
        key
    }
    pub fn take(&mut self, key: &str) -> Result<Vec<u8>> {
        self.values
            .remove(key)
            .context("Unknown or consumed binary payload")
    }
    pub fn receive(&mut self, key: &str, bytes: Vec<u8>) -> Result<()> {
        ensure!(
            !key.is_empty() && key.bytes().all(|c| c.is_ascii_digit()),
            "Invalid upload key"
        );
        ensure!(!self.values.contains_key(key), "Duplicate upload key");
        self.values.insert(key.to_owned(), bytes);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binary_uploads_exceed_the_prototype_asset_limit() {
        let mut store = Store::default();
        let mut bytes = vec![0; 129 * 1024 * 1024];
        bytes[0] = 7;
        let last = bytes.len() - 1;
        bytes[last] = 9;
        store.receive("1", bytes).unwrap();
        let bytes = store.take("1").unwrap();
        assert_eq!(bytes.len(), 129 * 1024 * 1024);
        assert_eq!([bytes[0], bytes[last]], [7, 9]);
        assert!(store.take("1").is_err());
    }
}
