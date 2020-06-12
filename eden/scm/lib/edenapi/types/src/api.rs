/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

//! Types for data interchange between the Mononoke API Server and the Mercurial client.

use std::iter::FromIterator;

use serde_derive::{Deserialize, Serialize};

use types::{hgid::HgId, key::Key, path::RepoPathBuf};

use crate::{
    dataentry::DataEntry,
    historyentry::{HistoryEntry, WireHistoryEntry},
};

#[derive(Debug, Serialize, Deserialize)]
pub struct DataRequest {
    pub keys: Vec<Key>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DataResponse {
    pub entries: Vec<DataEntry>,
}

impl DataResponse {
    pub fn new(entries: impl IntoIterator<Item = DataEntry>) -> Self {
        Self::from_iter(entries)
    }
}

impl FromIterator<DataEntry> for DataResponse {
    fn from_iter<I: IntoIterator<Item = DataEntry>>(entries: I) -> Self {
        Self {
            entries: entries.into_iter().collect(),
        }
    }
}

impl IntoIterator for DataResponse {
    type Item = DataEntry;
    type IntoIter = std::vec::IntoIter<DataEntry>;

    fn into_iter(self) -> Self::IntoIter {
        self.entries.into_iter()
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HistoryRequest {
    pub keys: Vec<Key>,
    pub length: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HistoryResponse {
    pub chunks: Vec<HistoryResponseChunk>,
}

impl HistoryResponse {
    pub fn new(chunks: impl IntoIterator<Item = HistoryResponseChunk>) -> Self {
        Self::from_iter(chunks)
    }
}

impl FromIterator<HistoryResponseChunk> for HistoryResponse {
    fn from_iter<I: IntoIterator<Item = HistoryResponseChunk>>(chunks: I) -> Self {
        Self {
            chunks: chunks.into_iter().collect(),
        }
    }
}

impl IntoIterator for HistoryResponse {
    type Item = HistoryEntry;
    type IntoIter = Box<dyn Iterator<Item = HistoryEntry> + Send + 'static>;

    fn into_iter(self) -> Self::IntoIter {
        Box::new(self.chunks.into_iter().flatten())
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HistoryResponseChunk {
    pub path: RepoPathBuf,
    pub entries: Vec<WireHistoryEntry>,
}

impl HistoryResponseChunk {
    pub fn new(path: RepoPathBuf, entries: impl IntoIterator<Item = WireHistoryEntry>) -> Self {
        Self {
            path,
            entries: entries.into_iter().collect(),
        }
    }
}

impl IntoIterator for HistoryResponseChunk {
    type Item = HistoryEntry;
    type IntoIter = Box<dyn Iterator<Item = HistoryEntry> + Send + 'static>;

    fn into_iter(self) -> Self::IntoIter {
        let path = self.path;
        let iter = self
            .entries
            .into_iter()
            .map(move |entry| HistoryEntry::from_wire(entry, path.clone()));

        Box::new(iter)
    }
}

/// Struct reprenting the arguments to a "gettreepack" operation, which
/// is used by Mercurial to prefetch treemanifests. This struct is intended
/// to provide a way to support requests compatible with Mercurial's existing
/// gettreepack wire protocol command.
///
/// In the future, we'd like to migrate away from requesting trees in this way.
/// In general, trees can be requested from the API server using a `DataRequest`
/// containing the keys of the desired tree nodes.
///
/// In all cases, trees will be returned in a `DataResponse`, so there is no
/// `TreeResponse` type to accompany `TreeRequest`.
#[derive(Debug, Serialize, Deserialize)]
pub struct TreeRequest {
    pub rootdir: RepoPathBuf,
    pub mfnodes: Vec<HgId>,
    pub basemfnodes: Vec<HgId>,
    pub depth: Option<usize>,
}

impl TreeRequest {
    pub fn new(
        rootdir: RepoPathBuf,
        mfnodes: Vec<HgId>,
        basemfnodes: Vec<HgId>,
        depth: Option<usize>,
    ) -> Self {
        Self {
            rootdir,
            mfnodes,
            basemfnodes,
            depth,
        }
    }
}
