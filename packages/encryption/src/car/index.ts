/**
 * The inner CAR: filecoin-pin's metadata-first CARv1 under an anonymous
 * wrapping directory. {@link planInnerCar} and {@link emitInnerCar} write it,
 * {@link unpackInnerCar} reads it, and {@link layout} maps it for range reads.
 *
 * @see https://github.com/filecoin-project/filecoin-pin/blob/feat/encryption-v2/src/common/unixfs-car-layout.ts
 * @module
 */

export {
  type CarLayout,
  carHeader,
  DAG_PB_CODEC,
  DEFAULT_MAX_METADATA_BYTES,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_TOTAL_PATH_BYTES,
  DEFAULT_MAX_VISITS,
  encodeVarint,
  type FileLeaf,
  type FilePlacement,
  isUnsafeName,
  type LayoutOptions,
  type LeafPlacement,
  type LeafTarget,
  layout,
  MAX_DEPTH,
  MAX_LEAF_BYTES,
  MAX_NAME_BYTES,
  MAX_PATH_BYTES,
  type MetadataNode,
  type NameOptions,
  RAW_CODEC,
  SHA256_CODE,
  sectionLength,
} from './layout.ts'
export {
  emitInnerCar,
  type InnerCarInput,
  type InnerCarPlan,
  type InputEntry,
  type InputSource,
  type PlanOptions,
  planInnerCar,
  type StreamOptions,
} from './pack.ts'
export {
  type UnpackOptions,
  type UnpackResult,
  type UnpackSink,
  type UnpackTree,
  unpackInnerCar,
} from './unpack.ts'
