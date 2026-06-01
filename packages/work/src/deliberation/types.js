"use strict";
// Deliberation types — T5
//
// Shared, audit-grade types for the multi-voice consensus primitive.
// See ~/.zana/artifacts/f4de8302-...json (design doc) for context.
//
// All hashes are canonical "sha256:<64-hex>" — produced by the content-
// addressed artifact store (T2). All timestamps are ISO 8601 strings.
// `bit` is uppercase to match the wire payload contract from T1.
Object.defineProperty(exports, "__esModule", { value: true });
