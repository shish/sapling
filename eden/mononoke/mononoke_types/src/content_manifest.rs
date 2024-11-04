/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

use anyhow::Result;
use blobstore::Blobstore;
use context::CoreContext;
use futures::stream::BoxStream;
use futures::stream::StreamExt;
use futures::stream::TryStreamExt;

use crate::blob::Blob;
use crate::blob::BlobstoreValue;
use crate::blob::ContentManifestBlob;
use crate::sharded_map_v2::ShardedMapV2Node;
use crate::sharded_map_v2::ShardedMapV2Value;
use crate::thrift;
use crate::typed_hash::ContentId;
use crate::typed_hash::ContentManifestId;
use crate::typed_hash::ContentManifestIdContext;
use crate::typed_hash::IdContext;
use crate::typed_hash::ShardedMapV2NodeContentManifestContext;
use crate::typed_hash::ShardedMapV2NodeContentManifestId;
use crate::FileType;
use crate::MPathElement;
use crate::ThriftConvert;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ContentManifestFile {
    pub content_id: ContentId,
    pub file_type: FileType,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ContentManifestDirectory {
    pub id: ContentManifestId,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ContentManifestEntry {
    File(ContentManifestFile),
    Directory(ContentManifestDirectory),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentManifest {
    pub subentries: ShardedMapV2Node<ContentManifestEntry>,
}

impl ContentManifest {
    pub fn empty() -> Self {
        Self {
            subentries: Default::default(),
        }
    }

    pub async fn lookup(
        &self,
        ctx: &CoreContext,
        blobstore: &impl Blobstore,
        name: &MPathElement,
    ) -> Result<Option<ContentManifestEntry>> {
        self.subentries.lookup(ctx, blobstore, name.as_ref()).await
    }

    pub fn into_subentries<'a>(
        self,
        ctx: &'a CoreContext,
        blobstore: &'a impl Blobstore,
    ) -> BoxStream<'a, Result<(MPathElement, ContentManifestEntry)>> {
        self.subentries
            .into_entries(ctx, blobstore)
            .and_then(|(k, v)| async move { anyhow::Ok((MPathElement::from_smallvec(k)?, v)) })
            .boxed()
    }

    pub fn into_prefix_subentries<'a>(
        self,
        ctx: &'a CoreContext,
        blobstore: &'a impl Blobstore,
        prefix: &'a [u8],
    ) -> BoxStream<'a, Result<(MPathElement, ContentManifestEntry)>> {
        self.subentries
            .into_prefix_entries(ctx, blobstore, prefix.as_ref())
            .and_then(|(k, v)| async move { anyhow::Ok((MPathElement::from_smallvec(k)?, v)) })
            .boxed()
    }
}

impl ThriftConvert for ContentManifestFile {
    const NAME: &'static str = "ContentManifestFile";
    type Thrift = thrift::content_manifest::ContentManifestFile;

    fn from_thrift(t: Self::Thrift) -> Result<Self> {
        Ok(Self {
            content_id: ThriftConvert::from_thrift(t.content_id)?,
            file_type: FileType::from_thrift(t.file_type)?,
            size: t.size as u64,
        })
    }

    fn into_thrift(self) -> Self::Thrift {
        Self::Thrift {
            content_id: self.content_id.into_thrift(),
            file_type: self.file_type.into_thrift(),
            size: self.size as i64,
        }
    }
}

impl ThriftConvert for ContentManifestDirectory {
    const NAME: &'static str = "ContentManifestDirectory";
    type Thrift = thrift::content_manifest::ContentManifestDirectory;

    fn from_thrift(t: Self::Thrift) -> Result<Self> {
        Ok(Self {
            id: ThriftConvert::from_thrift(t.id)?,
        })
    }

    fn into_thrift(self) -> Self::Thrift {
        Self::Thrift {
            id: self.id.into_thrift(),
        }
    }
}

impl ThriftConvert for ContentManifestEntry {
    const NAME: &'static str = "ContentManifestEntry";
    type Thrift = thrift::content_manifest::ContentManifestEntry;

    fn from_thrift(t: Self::Thrift) -> Result<Self> {
        match t {
            Self::Thrift::file(file) => Ok(Self::File(ThriftConvert::from_thrift(file)?)),
            Self::Thrift::directory(directory) => {
                Ok(Self::Directory(ThriftConvert::from_thrift(directory)?))
            }
            _ => Err(anyhow::anyhow!("Unknown ContentManifestEntry variant")),
        }
    }

    fn into_thrift(self) -> Self::Thrift {
        match self {
            Self::File(file) => Self::Thrift::file(file.into_thrift()),
            Self::Directory(directory) => Self::Thrift::directory(directory.into_thrift()),
        }
    }
}

impl ThriftConvert for ContentManifest {
    const NAME: &'static str = "ContentManifest";
    type Thrift = thrift::content_manifest::ContentManifest;

    fn from_thrift(t: Self::Thrift) -> Result<Self> {
        Ok(Self {
            subentries: ShardedMapV2Node::from_thrift(t.subentries)?,
        })
    }

    fn into_thrift(self) -> Self::Thrift {
        Self::Thrift {
            subentries: self.subentries.into_thrift(),
        }
    }
}

impl BlobstoreValue for ContentManifest {
    type Key = ContentManifestId;

    fn into_blob(self) -> ContentManifestBlob {
        let data = self.into_bytes();
        let id = ContentManifestIdContext::id_from_data(&data);
        Blob::new(id, data)
    }

    fn from_blob(blob: Blob<Self::Key>) -> Result<Self> {
        Self::from_bytes(blob.data())
    }
}

impl ShardedMapV2Value for ContentManifestEntry {
    type NodeId = ShardedMapV2NodeContentManifestId;
    type Context = ShardedMapV2NodeContentManifestContext;
    type RollupData = ();

    const WEIGHT_LIMIT: usize = 2000;
}
