/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

#include "eden/fs/store/filter/FilteredObjectId.h"

#include <folly/Varint.h>
#include <folly/logging/xlog.h>

#include "eden/fs/utils/Throw.h"

using folly::ByteRange;
using folly::Endian;
using folly::StringPiece;
using std::string;

namespace facebook::eden {

std::string FilteredObjectId::serializeBlob(const ObjectId& object) {
  // If we're dealing with a blob FilteredObjectId, we only need to
  // serialize two components: <type_byte><ObjectId>
  std::string buf;
  buf.reserve(1 + sizeof(object));
  uint8_t objectType = FilteredObjectId::OBJECT_TYPE_BLOB;

  buf.append(reinterpret_cast<const char*>(&objectType), sizeof(objectType));
  buf.append(object.asString());
  return buf;
}

std::string FilteredObjectId::serializeTree(
    RelativePathPiece path,
    std::string_view filterId,
    const ObjectId& object) {
  std::string buf;
  // We serialize trees as
  // <type_byte><varint><filter_set_id><varint><path><ObjectId>
  size_t pathLen = path.value().length();
  uint8_t pathVarint[folly::kMaxVarintLength64] = {};
  size_t pathVarintLen = folly::encodeVarint(pathLen, pathVarint);
  XLOGF(
      DBG9,
      "pathLen: {}, pathVarint: {}, pathVarintLen: {}",
      pathLen,
      pathVarint,
      pathVarintLen);

  size_t filterLen = filterId.length();
  uint8_t filterVarint[folly::kMaxVarintLength64] = {};
  size_t filterVarintLen = folly::encodeVarint(filterLen, filterVarint);
  XLOGF(
      INFO,
      "filterLen: {}, filterVarint: {}, pathVarintLen: {}",
      filterLen,
      filterVarint,
      filterVarintLen);
  uint8_t objectType = FilteredObjectId::OBJECT_TYPE_TREE;

  buf.reserve(
      sizeof(objectType) + pathVarintLen + pathLen + filterVarintLen +
      filterLen + sizeof(object));
  buf.append(reinterpret_cast<const char*>(&objectType), sizeof(objectType));
  buf.append(reinterpret_cast<const char*>(filterVarint), filterVarintLen);
  buf.append(filterId);
  buf.append(reinterpret_cast<const char*>(pathVarint), pathVarintLen);
  buf.append(path.value().begin(), path.value().end());
  buf.append(object.asString());
  return buf;
}

RelativePathPiece FilteredObjectId::path() const {
  switch (value_.data()[0]) {
    case FilteredObjectId::OBJECT_TYPE_TREE:
      // Skip the first byte of data that contains the type
      folly::Range r(value_.data(), value_.size());
      r.advance(sizeof(FilteredObjectId::OBJECT_TYPE_TREE));

      // Skip the variable length filter id. decodeVarint() advances the
      // range for us, so we don't need to skip the VarInt after reading it.
      size_t varintSize = folly::decodeVarint(r);
      r.advance(varintSize);
      varintSize = folly::decodeVarint(r);

      StringPiece data{r.begin(), varintSize};
      // value_ was built with a known good RelativePath, thus we don't need
      // to recheck it when deserializing.
      return RelativePathPiece{data, detail::SkipPathSanityCheck{}};
  }
  // We don't know the path of non-tree objects. Throw.
  throwf<std::invalid_argument>(
      "Cannot determine path of non-tree FilteredObjectId: {}", value_);
}

StringPiece FilteredObjectId::filter() const {
  switch (value_.data()[0]) {
    case FilteredObjectId::OBJECT_TYPE_TREE:
      // Skip the first byte of data that contains the type
      folly::Range r(value_.data(), value_.size());
      r.advance(sizeof(FilteredObjectId::OBJECT_TYPE_TREE));

      // Determine the location/size of the filter
      size_t varintSize = folly::decodeVarint(r);

      // decodeVarint advances the range for us, so we can use the current
      // start of the range.
      StringPiece data{r.begin(), varintSize};
      return data;
  }
  // We don't know the filter of non-tree objects. Throw.
  throwf<std::invalid_argument>(
      "Cannot determine filter for non-tree FilteredObjectId: {}", value_);
}

ObjectId FilteredObjectId::object() const {
  switch (value_.data()[0]) {
    case FilteredObjectId::OBJECT_TYPE_TREE: {
      // Skip the first byte of data that contains the type
      folly::Range r(value_.data(), value_.size());
      r.advance(sizeof(FilteredObjectId::OBJECT_TYPE_TREE));

      // Determine the location/size of the filter and skip it
      size_t varintSize = folly::decodeVarint(r);
      r.advance(varintSize);

      // Determine the location/size of the path and skip it
      varintSize = folly::decodeVarint(r);
      r.advance(varintSize);

      // Parse the ObjectId bytes and use them to create an ObjectId
      ObjectId object = ObjectId{r};
      return object;
    }

    case FilteredObjectId::OBJECT_TYPE_BLOB: {
      folly::Range r(value_.data(), value_.size());
      r.advance(sizeof(FilteredObjectId::OBJECT_TYPE_BLOB));
      ObjectId object = ObjectId{r};
      return object;
    }
  }
  // Unknown FilteredObjectId type. Throw.
  throwf<std::runtime_error>(
      "Unknown FilteredObjectId type: {}", value_.data()[0]);
}

// Since some FilteredObjectIds are created without validation, we should
// validate that we return a valid type.
FilteredObjectId::FilteredObjectIdType FilteredObjectId::objectType() const {
  switch (value_.data()[0]) {
    case FilteredObjectId::OBJECT_TYPE_TREE:
      return FilteredObjectIdType::OBJECT_TYPE_TREE;
    case FilteredObjectId::OBJECT_TYPE_BLOB:
      return FilteredObjectIdType::OBJECT_TYPE_BLOB;
  }
  // Unknown FilteredObjectId type. Throw.
  throwf<std::runtime_error>("Unknown FilteredObjectId type: {}", value_[0]);
}

// It's possible that FilteredObjectIds with different filterIds evaluate to
// the same underlying object. However, that's not for the FilteredObjectId
// implementation to decide. This implementation strictly checks if the FOID
// contents are byte-wise equal.
bool FilteredObjectId::operator==(const FilteredObjectId& otherHash) const {
  return value_ == otherHash.value_;
}

// The comment above for == also applies here.
bool FilteredObjectId::operator<(const FilteredObjectId& otherHash) const {
  return value_ < otherHash.value_;
}

void FilteredObjectId::validate() {
  ByteRange infoBytes = folly::Range{value_.data(), value_.size()};
  XLOGF(DBG9, "{}", value_);

  // Ensure the type byte is valid
  uint8_t typeByte = infoBytes.data()[0];
  if (typeByte != FilteredObjectId::OBJECT_TYPE_BLOB &&
      typeByte != FilteredObjectId::OBJECT_TYPE_TREE) {
    auto msg = fmt::format(
        "Invalid FilteredObjectId type byte {}. Value_ = {}", typeByte, value_);
    XLOGF(ERR, "{}", msg);
    throw std::invalid_argument(msg);
  }
  infoBytes.advance(1);

  // Validating the wrapped ObjectId is impossible since we don't know what
  // it should contain. Therefore, we simply return if we're validating a
  // filtered blob Id.
  if (typeByte == FilteredObjectId::OBJECT_TYPE_BLOB) {
    return;
  }

  // For trees, we can actually perform some validation. We can ensure the
  // varints describing the filterid and path are valid
  auto expectedSize = folly::tryDecodeVarint(infoBytes);
  if (UNLIKELY(!expectedSize)) {
    auto msg = fmt::format(
        "failed to decode filter id VarInt when validating FilteredObjectId {}: {}",
        value_,
        expectedSize.error());
    throw std::invalid_argument(msg);
  }
  infoBytes.advance(*expectedSize);

  expectedSize = folly::tryDecodeVarint(infoBytes);
  if (UNLIKELY(!expectedSize)) {
    auto msg = fmt::format(
        "failed to decode path length VarInt when validating FilteredObjectId {}: {}",
        value_,
        expectedSize.error());
    throw std::invalid_argument(msg);
  }
}

} // namespace facebook::eden
