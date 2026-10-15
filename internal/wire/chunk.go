package wire

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"
)

// Chrome caps native messages host→extension at 1 MB. Frames above
// ChunkThreshold are split into chunk envelopes:
//
//	{"chunk":{"id":"<id>","i":<index>,"n":<count>,"data":"<base64>"}}
//
// data is the base64 of a byte slice of the original UTF-8 JSON payload;
// concatenating the decoded slices in index order yields that payload. The
// same envelope is accepted in the extension→host direction.
const (
	ChunkThreshold = 900 * 1024
	// 640 KiB raw → 853.4 KiB base64 + envelope, under ChunkThreshold.
	ChunkRawBytes = 640 * 1024
	// Partial chunk sets older than this are dropped.
	ChunkTTL = 60 * time.Second
	// Upper bound on bytes buffered across all partial chunk sets.
	MaxChunkBuffer = 256 * 1024 * 1024
)

var chunkPrefix = []byte(`{"chunk":`)

type chunkHeader struct {
	ID string
	I  int
	N  int
}

// parseChunk reads a chunk envelope without decoding the (large) data string
// through encoding/json: base64 never contains JSON escapes.
func parseChunk(payload []byte) (chunkHeader, []byte, error) {
	var c chunkHeader
	inner, ok, err := FindKey(payload, "chunk")
	if err != nil || !ok {
		return c, nil, fmt.Errorf("%w: missing chunk object", ErrChunk)
	}
	body := payload[inner.Start:inner.End]
	field := func(key string) ([]byte, error) {
		span, ok, err := FindKey(body, key)
		if err != nil || !ok {
			return nil, fmt.Errorf("%w: missing %s", ErrChunk, key)
		}
		return body[span.Start:span.End], nil
	}
	rawID, err := field("id")
	if err != nil {
		return c, nil, err
	}
	if err := json.Unmarshal(rawID, &c.ID); err != nil {
		return c, nil, fmt.Errorf("%w: id: %v", ErrChunk, err)
	}
	for key, dst := range map[string]*int{"i": &c.I, "n": &c.N} {
		raw, err := field(key)
		if err != nil {
			return c, nil, err
		}
		if *dst, err = strconv.Atoi(string(raw)); err != nil {
			return c, nil, fmt.Errorf("%w: %s: %v", ErrChunk, key, err)
		}
	}
	if c.ID == "" || c.N <= 0 || c.N > 4096 || c.I < 0 || c.I >= c.N {
		return c, nil, fmt.Errorf("%w: bad header id=%q i=%d n=%d", ErrChunk, c.ID, c.I, c.N)
	}
	rawData, err := field("data")
	if err != nil {
		return c, nil, err
	}
	if len(rawData) < 2 || rawData[0] != '"' || bytes.IndexByte(rawData[1:len(rawData)-1], '\\') >= 0 {
		return c, nil, fmt.Errorf("%w: data must be a base64 string", ErrChunk)
	}
	data := make([]byte, base64.StdEncoding.DecodedLen(len(rawData)-2))
	n, err := base64.StdEncoding.Decode(data, rawData[1:len(rawData)-1])
	if err != nil {
		return c, nil, fmt.Errorf("%w: %v", ErrChunk, err)
	}
	return c, data[:n], nil
}

// SplitChunks returns payload as-is when it fits, otherwise chunk frames.
func SplitChunks(payload []byte, id string) [][]byte {
	if len(payload) <= ChunkThreshold {
		return [][]byte{payload}
	}
	n := (len(payload) + ChunkRawBytes - 1) / ChunkRawBytes
	frames := make([][]byte, 0, n)
	quotedID := strconv.Quote(id)
	for i := 0; i < n; i++ {
		start := i * ChunkRawBytes
		end := min(start+ChunkRawBytes, len(payload))
		part := payload[start:end]
		var b bytes.Buffer
		b.Grow(base64.StdEncoding.EncodedLen(len(part)) + 64 + len(quotedID))
		b.WriteString(`{"chunk":{"id":`)
		b.WriteString(quotedID)
		b.WriteString(`,"i":`)
		b.WriteString(strconv.Itoa(i))
		b.WriteString(`,"n":`)
		b.WriteString(strconv.Itoa(n))
		b.WriteString(`,"data":"`)
		enc := make([]byte, base64.StdEncoding.EncodedLen(len(part)))
		base64.StdEncoding.Encode(enc, part)
		b.Write(enc)
		b.WriteString(`"}}`)
		frames = append(frames, b.Bytes())
	}
	return frames
}

// IsChunk reports whether payload is a chunk envelope (cheap prefix check).
func IsChunk(payload []byte) bool {
	return bytes.HasPrefix(bytes.TrimLeft(payload, " \t\r\n"), chunkPrefix)
}

type partial struct {
	parts    [][]byte
	received int
	bytes    int
	started  time.Time
}

// Reassembler collects chunk envelopes into whole payloads.
type Reassembler struct {
	mu      sync.Mutex
	pending map[string]*partial
	total   int
	now     func() time.Time
}

func NewReassembler() *Reassembler {
	return &Reassembler{pending: make(map[string]*partial), now: time.Now}
}

var ErrChunk = errors.New("invalid chunk")

// Add consumes one chunk envelope. It returns the full payload once the last
// chunk of a set arrives, or nil while the set is incomplete.
func (r *Reassembler) Add(payload []byte) ([]byte, error) {
	c, data, err := parseChunk(payload)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.expireLocked()
	p := r.pending[c.ID]
	if p == nil {
		p = &partial{parts: make([][]byte, c.N), started: r.now()}
		r.pending[c.ID] = p
	}
	if len(p.parts) != c.N {
		r.dropLocked(c.ID)
		return nil, fmt.Errorf("%w: chunk count changed for %q", ErrChunk, c.ID)
	}
	if p.parts[c.I] != nil {
		return nil, fmt.Errorf("%w: duplicate chunk %d for %q", ErrChunk, c.I, c.ID)
	}
	if r.total+len(data) > MaxChunkBuffer {
		r.dropLocked(c.ID)
		return nil, fmt.Errorf("%w: buffer limit exceeded", ErrChunk)
	}
	p.parts[c.I] = data
	p.received++
	p.bytes += len(data)
	r.total += len(data)
	if p.received < c.N {
		return nil, nil
	}
	out := make([]byte, 0, p.bytes)
	for _, part := range p.parts {
		out = append(out, part...)
	}
	r.dropLocked(c.ID)
	return out, nil
}

// Pending returns the number of incomplete chunk sets.
func (r *Reassembler) Pending() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.pending)
}

func (r *Reassembler) dropLocked(id string) {
	if p := r.pending[id]; p != nil {
		r.total -= p.bytes
		delete(r.pending, id)
	}
}

func (r *Reassembler) expireLocked() {
	cutoff := r.now().Add(-ChunkTTL)
	for id, p := range r.pending {
		if p.started.Before(cutoff) {
			r.dropLocked(id)
		}
	}
}
