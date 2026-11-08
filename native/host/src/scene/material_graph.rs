//! Raw graph spans and relocation. Semantics are checked by the shared AOT IR validator.
use super::{Result, Words};
use crate::layout::graph as g;
const TABLES: [(usize, usize, usize); 5] = [
    (g::NODE_COUNT, g::NODES, 5),
    (g::INPUT_COUNT, g::INPUTS, 5),
    (g::TERMINAL_COUNT, g::TERMINALS, 3),
    (g::PARAMETER_COUNT, g::PARAMETERS, 4),
    (g::TEXTURE_COUNT, g::TEXTURES, 1),
];
pub(super) fn validate(w: &Words<'_>, at: usize, textures: usize) -> Result<()> {
    if at == 0 {
        return Ok(());
    }
    w.span(at, g::WORDS)?;
    w.reserved(at + g::RESERVED, 4)?;
    for (count, offset, stride) in TABLES {
        let (count, offset) = (w.u(at + count), w.u(at + offset));
        if count == 0 && offset != 0 || count != 0 && offset < crate::layout::header::WORDS {
            return Err("Invalid graph count/offset".into());
        }
        if count != 0 {
            w.span(offset, count * stride)?;
        }
    }
    w.finite(w.u(at + g::PARAMETERS), w.u(at + g::PARAMETER_COUNT) * 4)?;
    for i in 0..w.u(at + g::TEXTURE_COUNT) {
        let texture = w.u(w.u(at + g::TEXTURES) + i);
        if texture != u32::MAX as usize && texture >= textures {
            return Err("Graph texture reference is out of range".into());
        }
    }
    let ids = w.u(at + g::AUTHOR_IDS);
    if ids != 0 {
        w.span(ids, w.u(at + g::NODE_COUNT) * 2)?;
        for i in 0..w.u(at + g::NODE_COUNT) {
            let offset = w.u(ids + i * 2);
            let length = w.u(ids + i * 2 + 1);
            w.span(offset, length.div_ceil(4))?;
            let text = &w.0[offset * 4..offset * 4 + length];
            std::str::from_utf8(text).map_err(|_| "Graph author ID must be UTF-8")?;
            if w.0[offset * 4 + length..(offset + length.div_ceil(4)) * 4]
                .iter()
                .any(|b| *b != 0)
            {
                return Err("Graph author ID padding must be zero".into());
            }
        }
    }
    Ok(())
}
fn same_tables(a: &Words<'_>, ao: usize, b: &Words<'_>, bo: usize, values: bool) -> bool {
    if ao == 0 || bo == 0 {
        return ao == bo;
    }
    if a.u(ao + g::VERSION) != b.u(bo + g::VERSION) {
        return false;
    }
    TABLES.iter().all(|&(count, offset, stride)| {
        let n = a.u(ao + count);
        n == b.u(bo + count)
            && (!values && matches!(count, g::PARAMETER_COUNT | g::TEXTURE_COUNT)
                || a.0[a.u(ao + offset) * 4..(a.u(ao + offset) + n * stride) * 4]
                    == b.0[b.u(bo + offset) * 4..(b.u(bo + offset) + n * stride) * 4])
    })
}
pub(crate) fn same_topology(a: &[u8], ao: usize, b: &[u8], bo: usize) -> bool {
    same_tables(&Words(a), ao, &Words(b), bo, false)
}
pub(crate) fn same_data(a: &[u8], ao: usize, b: &[u8], bo: usize) -> bool {
    let (a, b) = (Words(a), Words(b));
    if !same_tables(&a, ao, &b, bo, true) {
        return false;
    }
    if ao == 0 {
        return true;
    }
    let (ai, bi) = (a.u(ao + g::AUTHOR_IDS), b.u(bo + g::AUTHOR_IDS));
    if ai == 0 || bi == 0 {
        return ai == bi;
    }
    (0..a.u(ao + g::NODE_COUNT)).all(|i| {
        let (an, bn) = (a.u(ai + i * 2 + 1), b.u(bi + i * 2 + 1));
        an == bn
            && a.0[a.u(ai + i * 2) * 4..a.u(ai + i * 2) * 4 + an]
                == b.0[b.u(bi + i * 2) * 4..b.u(bi + i * 2) * 4 + bn]
    })
}
/// Relocate a validated graph and all its spans into a sparse material packet.
pub(crate) fn append(bytes: &mut Vec<u8>, source: &[u8], at: usize) -> Option<usize> {
    if at == 0 {
        return Some(0);
    }
    let w = Words(source);
    let target = bytes.len() / 4;
    bytes.extend_from_slice(source.get(at * 4..(at + g::WORDS) * 4)?);
    let set = |bytes: &mut Vec<u8>, field: usize, value: usize| {
        bytes[(target + field) * 4..(target + field + 1) * 4]
            .copy_from_slice(&(value as u32).to_le_bytes());
    };
    for (count, offset, stride) in TABLES {
        let n = w.u(at + count) * stride;
        let dest = if n == 0 {
            0
        } else {
            let dest = bytes.len() / 4;
            bytes.extend_from_slice(source.get(w.u(at + offset) * 4..(w.u(at + offset) + n) * 4)?);
            dest
        };
        set(bytes, offset, dest);
    }
    let ids = w.u(at + g::AUTHOR_IDS);
    if ids != 0 {
        let dest = bytes.len() / 4;
        let count = w.u(at + g::NODE_COUNT);
        bytes.extend_from_slice(source.get(ids * 4..(ids + count * 2) * 4)?);
        set(bytes, g::AUTHOR_IDS, dest);
        for i in 0..count {
            let words = w.u(ids + i * 2 + 1).div_ceil(4);
            let offset = w.u(ids + i * 2);
            let text_dest = bytes.len() / 4;
            bytes.extend_from_slice(source.get(offset * 4..(offset + words) * 4)?);
            bytes[(dest + i * 2) * 4..(dest + i * 2 + 1) * 4]
                .copy_from_slice(&(text_dest as u32).to_le_bytes());
        }
    }
    Some(target)
}
