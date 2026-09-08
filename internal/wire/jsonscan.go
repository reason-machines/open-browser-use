package wire

import (
	"bytes"
	"errors"
)

// ErrNotObject is returned when a payload's top level is not a JSON object.
var ErrNotObject = errors.New("json payload is not an object")

var errMalformed = errors.New("malformed json")

// Span is a half-open byte range [Start, End) inside a JSON payload.
type Span struct {
	Start int
	End   int
}

// FindKey locates the raw value of key in the top-level JSON object of
// payload without decoding it. The relay uses this to rewrite only `id` so a
// multi-megabyte screenshot never goes through map[string]any. Keys are
// compared byte-for-byte against their raw (still escaped) form, which is
// exact for the ASCII keys the protocol uses.
func FindKey(payload []byte, key string) (Span, bool, error) {
	i := skipSpace(payload, 0)
	if i >= len(payload) || payload[i] != '{' {
		return Span{}, false, ErrNotObject
	}
	i = skipSpace(payload, i+1)
	if i < len(payload) && payload[i] == '}' {
		return Span{}, false, nil
	}
	for i < len(payload) {
		if payload[i] != '"' {
			return Span{}, false, errMalformed
		}
		keyEnd, err := skipString(payload, i)
		if err != nil {
			return Span{}, false, err
		}
		rawKey := payload[i+1 : keyEnd-1]
		i = skipSpace(payload, keyEnd)
		if i >= len(payload) || payload[i] != ':' {
			return Span{}, false, errMalformed
		}
		i = skipSpace(payload, i+1)
		valueEnd, err := skipValue(payload, i)
		if err != nil {
			return Span{}, false, err
		}
		if string(rawKey) == key {
			return Span{Start: i, End: valueEnd}, true, nil
		}
		i = skipSpace(payload, valueEnd)
		if i >= len(payload) {
			return Span{}, false, errMalformed
		}
		switch payload[i] {
		case ',':
			i = skipSpace(payload, i+1)
		case '}':
			return Span{}, false, nil
		default:
			return Span{}, false, errMalformed
		}
	}
	return Span{}, false, errMalformed
}

// FindPath walks nested objects (e.g. "params", "timeoutMs").
func FindPath(payload []byte, keys ...string) (Span, bool, error) {
	span := Span{Start: 0, End: len(payload)}
	for _, key := range keys {
		inner, ok, err := FindKey(payload[span.Start:span.End], key)
		if err != nil || !ok {
			return Span{}, ok, err
		}
		span = Span{Start: span.Start + inner.Start, End: span.Start + inner.End}
	}
	return span, true, nil
}

// Splice returns payload with the bytes in span replaced by value.
func Splice(payload []byte, span Span, value []byte) []byte {
	out := make([]byte, 0, len(payload)-(span.End-span.Start)+len(value))
	out = append(out, payload[:span.Start]...)
	out = append(out, value...)
	return append(out, payload[span.End:]...)
}

func skipSpace(b []byte, i int) int {
	for i < len(b) {
		switch b[i] {
		case ' ', '\t', '\n', '\r':
			i++
		default:
			return i
		}
	}
	return i
}

// skipString expects b[i] == '"' and returns the index just past the closing quote.
func skipString(b []byte, i int) (int, error) {
	i++
	for {
		j := bytes.IndexAny(b[i:], "\"\\")
		if j < 0 {
			return 0, errMalformed
		}
		i += j
		if b[i] == '"' {
			return i + 1, nil
		}
		i += 2 // skip escape and the escaped byte
		if i > len(b) {
			return 0, errMalformed
		}
	}
}

func skipValue(b []byte, i int) (int, error) {
	if i >= len(b) {
		return 0, errMalformed
	}
	switch b[i] {
	case '"':
		return skipString(b, i)
	case '{', '[':
		depth := 0
		for i < len(b) {
			switch b[i] {
			case '"':
				end, err := skipString(b, i)
				if err != nil {
					return 0, err
				}
				i = end
				continue
			case '{', '[':
				depth++
			case '}', ']':
				depth--
				if depth == 0 {
					return i + 1, nil
				}
			}
			i++
		}
		return 0, errMalformed
	default:
		start := i
		for i < len(b) {
			switch b[i] {
			case ',', '}', ']', ' ', '\t', '\n', '\r':
				if i == start {
					return 0, errMalformed
				}
				return i, nil
			}
			i++
		}
		if i == start {
			return 0, errMalformed
		}
		return i, nil
	}
}
