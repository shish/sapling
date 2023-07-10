/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

#pragma once

#include <string>
#include "eden/fs/model/ObjectId.h"
#include "eden/fs/utils/PathFuncs.h"

namespace facebook::eden {

/**
 * FilteredBackingStores need to keep track of a few extra pieces of state with
 * each ObjectId in order to properly filter objects across their lifetime.
 *
 * The first crucial piece of information they need is whether the given object
 * is a tree or a blob. This is defined in the first byte of the ObjectId. The
 * rest of the FilteredObjectId (FOID for short) is different depending on the
 * object's type (tree or blob).
 *
 * ============= Blob FOIDs =============
 *
 * By filtering trees directly, we get blob filtering for free! This is because
 * we process (and filter) the direct children of a tree whenever we process a
 * tree itself. Any filtered blobs are unreachable after their parent tree is
 * processed.
 *
 * This means Blob FOIDs don't need any extra information associated with them
 * besides the type byte mentioned above. Our Blob FOIDs are in the form:
 *
 * <blob_or_tree_type_byte><ObjectId>
 *
 * The ObjectId mentioned above can be used in whatever BackingStore the
 * FilteredBackingStore is wrapped around. In most cases, this will be an
 * HgObjectID.
 *
 * ============= Tree FOIDs =============
 *
 * For trees, we need to keep track of what filter was active when the ObjectId
 * was created when the corresponding tree was fetched. This information is
 * variable length, so we use a VarInt to encode the length of the filter id.
 *
 * We also need to keep track of the path associated with the tree object so we
 * can determine whether the object needs to be filtered prior to fetching any
 * data associated with it. The path is variable length, so we use a VarInt to
 * encode the length of the path.
 *
 * Finally, like blobs, we include an ObjectId we can use in the BackingStore
 * the FilteredBackingStore wraps. ObjectIds are variable length, but we place
 * them at the end of the ObjectID. Therefore we should always know where they
 * end. This gives us the form:
 *
 * <blob_or_tree_type_byte><VarInt><filter_set_id><varint><path><ObjectId>
 */
class FilteredObjectId {
 public:
  /**
   * It doesn't make sense for a FilteredObjectId to be default constructed. At
   * a minimum, a wrapped ObjectId must be provided.
   */
  FilteredObjectId() = delete;

  /**
   * Construct a filtered *blob* object id.
   */
  explicit FilteredObjectId(const ObjectId& edenObjectId)
      : value_{serializeBlob(edenObjectId)} {
    validate();
  }

  /**
   * Construct a filtered *tree* object id.
   */
  FilteredObjectId(
      RelativePathPiece path,
      std::string_view filterId,
      const ObjectId& edenObjectId)
      : value_{serializeTree(path, filterId, edenObjectId)} {
    validate();
  }

  /**
   * This function should only be used when the caller knows the underlying
   * bytes from the passed in ObjectId is in the form of a FilteredObjectId.
   */
  static FilteredObjectId fromObjectId(const ObjectId& id) {
    return FilteredObjectId{id.getBytes()};
  }

  explicit FilteredObjectId(std::string str) noexcept : value_{std::move(str)} {
    validate();
  }

  explicit FilteredObjectId(folly::ByteRange bytes)
      : value_{constructFromByteRange(bytes)} {
    validate();
  }

  ~FilteredObjectId() = default;

  FilteredObjectId(const FilteredObjectId& other) = default;
  FilteredObjectId& operator=(const FilteredObjectId& other) = default;

  FilteredObjectId(FilteredObjectId&& other) noexcept
      : value_{std::exchange(other.value_, std::string{})} {}

  FilteredObjectId& operator=(FilteredObjectId&& other) noexcept {
    value_ = std::exchange(other.value_, std::string{});
    return *this;
  }

  /*
   * Returns the path portion of the *tree* FilteredObjectId. NOTE: This
   * function will throw an exception if it is called on a Blob FOID!
   */
  RelativePathPiece path() const;

  /*
   * Returns the filter portion of the *tree* FilteredObjectId. NOTE: This
   * function will throw an exception if it is called on a Blob FOID!
   */
  folly::StringPiece filter() const;

  /*
   * Returns the object portion of the FilteredObjectId. NOTE: This function
   * works for BOTH Blob and Tree FOIDs.
   */
  ObjectId object() const;

  // We start FilteredObjectId types at 0x10 so that they can be distinguished
  // from HgProxyHash types that start at 0x01 and extend until 0x02. In the
  // future, this could help us migrate HgProxyHash-based ObjectIds to
  // FilteredObjectIds.
  enum FilteredObjectIdType : uint8_t {
    // If the Object ID's type is 16, then it represents a blob object and is of
    // the form <blob_type_byte><ObjectId>
    OBJECT_TYPE_BLOB = 0x10,

    // If the Object ID's type is 17, then it represents a tree object and is of
    // the form <tree_type_byte><filter_set_id><path><ObjectId>
    OBJECT_TYPE_TREE = 0x11,
  };

  /*
   * Returns the type of the FilteredObjectId. NOTE: This function works for
   * BOTH Blob and Tree FOIDs.
   */
  FilteredObjectIdType objectType() const;

  bool operator==(const FilteredObjectId&) const;
  bool operator<(const FilteredObjectId&) const;

  const std::string& getValue() const {
    return value_;
  }

 private:
  static std::string constructFromByteRange(folly::ByteRange bytes) {
    return std::string{(const char*)bytes.data(), bytes.size()};
  }

  /**
   * Serialize the tree path, filter, and object data into a buffer that will
   * be stored in the LocalStore.
   */
  static std::string serializeTree(
      RelativePathPiece path,
      std::string_view filterId,
      const ObjectId&);

  /**
   * Serialize the blob object data into a buffer that will be stored in the
   * LocalStore.
   */
  static std::string serializeBlob(const ObjectId& object);

  /**
   * Validate data found in value_.
   *
   * The value_ member variable should already contain the serialized data,
   * (as returned by serialize()).
   *
   * Note there will be an exception being thrown if `value_` is invalid.
   */
  void validate();

  /**
   * The serialized data as written in the LocalStore.
   */
  std::string value_;
};

} // namespace facebook::eden
