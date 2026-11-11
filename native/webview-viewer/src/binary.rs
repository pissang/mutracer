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
    uploads: HashMap<String, (usize, Vec<u8>)>,
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
    pub fn clear(&mut self) {
        self.values.clear();
        self.uploads.clear();
    }
    pub fn discard(&mut self, key: &str) {
        self.values.remove(key);
        self.uploads.remove(key);
    }
    pub fn receive_chunk(
        &mut self,
        key: &str,
        offset: usize,
        total: usize,
        bytes: Vec<u8>,
    ) -> Result<()> {
        ensure!(
            !key.is_empty() && key.bytes().all(|c| c.is_ascii_digit()),
            "Invalid upload key"
        );
        ensure!(!self.values.contains_key(key), "Duplicate upload key");
        ensure!(
            offset <= total && bytes.len() <= total - offset,
            "Invalid upload range"
        );
        if offset == 0 {
            ensure!(!self.uploads.contains_key(key), "Duplicate upload start");
            let mut data = Vec::new();
            data.try_reserve_exact(total)
                .context("Cannot allocate scene upload")?;
            self.uploads.insert(key.to_owned(), (total, data));
        }
        let (length, data) = self.uploads.get_mut(key).context("Upload not started")?;
        ensure!(
            *length == total && data.len() == offset,
            "Out-of-order upload chunk"
        );
        data.extend_from_slice(&bytes);
        if data.len() == total {
            let (_, data) = self.uploads.remove(key).unwrap();
            self.values.insert(key.to_owned(), data);
        }
        Ok(())
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
    fn chunk_uploads_are_ordered_transactional_and_released_on_reset() {
        let mut store = Store::default();
        store.receive_chunk("1", 0, 5, vec![1, 2]).unwrap();
        assert!(store.take("1").is_err());
        assert!(store.receive_chunk("1", 3, 5, vec![3]).is_err());
        assert!(store.receive_chunk("1", 2, 6, vec![3]).is_err());
        store.receive_chunk("1", 2, 5, vec![3, 4, 5]).unwrap();
        assert_eq!(store.take("1").unwrap(), vec![1, 2, 3, 4, 5]);
        store.receive_chunk("2", 0, 3, vec![1]).unwrap();
        store.clear();
        assert!(store.receive_chunk("2", 1, 3, vec![2, 3]).is_err());
    }
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
