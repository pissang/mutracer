#ifndef MUTRACER_MATERIAL_GRAPH_H
#define MUTRACER_MATERIAL_GRAPH_H
#include <stdint.h>
#include "mutracer-layout.h"
#include "mutracer-material-graph-schema.h"
/* Canonical, topologically ordered graph records. IDs use MT_GRAPH_* constants.
 * Node implementation is 1. Every normalized input, including defaults, is
 * explicit. first_input/input_count count input records, not words. */
typedef struct mt_graph_node {
  uint32_t category, implementation, port_type, first_input, input_count;
} mt_graph_node;
/* source_kind selects a parameter slot, earlier node or implicit geometry ID.
 * output is MT_GRAPH_OUTPUT_OUT (0) except for connected node outputs. */
typedef struct mt_graph_input {
  uint32_t port, port_type, source_kind, source, output;
} mt_graph_input;
typedef struct mt_graph_terminal {
  uint32_t port, node, output;
} mt_graph_terminal;
/* Optional raw v8 material graph. All offsets are descriptor word offsets.
 * Parameters are parameter_count groups of four finite float32 values, with
 * unused components zero. Filename values index the texture table, or are -1
 * for the image default. Texture entries are descriptor texture indices or
 * MT_NO_TEXTURE (UINT32_MAX). author_ids_offset is 0 or node_count pairs of
 * (UTF-8 word offset, byte length), without a NUL and padded to words with zero.
 * Reserved fields are zero. A zero material graph_offset means no graph. */
typedef struct mt_material_graph_v8 {
  uint32_t version; /* MT_GRAPH_IR_VERSION */
  uint32_t node_count, nodes_offset;
  uint32_t input_count, inputs_offset;
  uint32_t terminal_count, terminals_offset;
  uint32_t parameter_count, parameters_offset;
  uint32_t texture_count, textures_offset;
  uint32_t author_ids_offset;
  uint32_t reserved[4];
} mt_material_graph_v8;
#if defined(__cplusplus)
static_assert(sizeof(mt_graph_node)==20 && sizeof(mt_graph_input)==20 && sizeof(mt_graph_terminal)==12 && sizeof(mt_material_graph_v8)==64, "material graph record layout");
#elif defined(__STDC_VERSION__) && __STDC_VERSION__>=201112L
_Static_assert(sizeof(mt_graph_node)==20 && sizeof(mt_graph_input)==20 && sizeof(mt_graph_terminal)==12 && sizeof(mt_material_graph_v8)==64, "material graph record layout");
#endif
#endif
