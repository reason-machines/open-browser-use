package wire

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestSplitChunksSmallPassthrough(t *testing.T) {
	payload := []byte(`{"id":1}`)
	frames := SplitChunks(payload, "x")
	if len(frames) != 1 || !bytes.Equal(frames[0], payload) {
		t.Fatalf("unexpected frames %q", frames)
	}
}

func TestSplitAndReassembleRoundTrip(t *testing.T) {
	payload := []byte(`{"id":"obu:1","params":{"data":"` + strings.Repeat("é漢🙂x", 400_000) + `"}}`)
	frames := SplitChunks(payload, "obu:1")
	if len(frames) < 2 {
		t.Fatalf("expected chunks, got %d", len(frames))
	}
	r := NewReassembler()
	var whole []byte
	// deliver out of order: last first
	order := append([]int{len(frames) - 1}, seq(len(frames)-1)...)
	for k, i := range order {
		f := frames[i]
		if len(f) > ChunkThreshold+1024 {
			t.Fatalf("chunk %d too big: %d", i, len(f))
		}
		if !IsChunk(f) {
			t.Fatalf("frame %d not detected as chunk", i)
		}
		var env map[string]any
		if err := json.Unmarshal(f, &env); err != nil {
			t.Fatalf("chunk %d not JSON: %v", i, err)
		}
		out, err := r.Add(f)
		if err != nil {
			t.Fatal(err)
		}
		if k < len(order)-1 && out != nil {
			t.Fatal("completed early")
		}
		whole = out
	}
	if !bytes.Equal(whole, payload) {
		t.Fatal("reassembled payload differs")
	}
	if r.Pending() != 0 {
		t.Fatal("pending not cleared")
	}
}

func TestReassemblerRejectsBadChunksAndExpires(t *testing.T) {
	r := NewReassembler()
	if _, err := r.Add([]byte(`{"chunk":{"id":"a","i":2,"n":2,"data":""}}`)); err == nil {
		t.Fatal("expected bad index error")
	}
	if _, err := r.Add([]byte(`{"chunk":{"id":"a","i":0,"n":2,"data":"!!"}}`)); err == nil {
		t.Fatal("expected base64 error")
	}
	now := time.Now()
	r.now = func() time.Time { return now }
	if out, err := r.Add([]byte(`{"chunk":{"id":"b","i":0,"n":2,"data":"YQ=="}}`)); err != nil || out != nil {
		t.Fatalf("out=%v err=%v", out, err)
	}
	if _, err := r.Add([]byte(`{"chunk":{"id":"b","i":0,"n":2,"data":"YQ=="}}`)); err == nil {
		t.Fatal("expected duplicate error")
	}
	now = now.Add(ChunkTTL + time.Second)
	if out, err := r.Add([]byte(`{"chunk":{"id":"c","i":0,"n":2,"data":"YQ=="}}`)); err != nil || out != nil {
		t.Fatalf("out=%v err=%v", out, err)
	}
	if r.Pending() != 1 {
		t.Fatalf("expected expired set dropped, pending=%d", r.Pending())
	}
}

func seq(n int) []int {
	out := make([]int, n)
	for i := range out {
		out[i] = i
	}
	return out
}

func BenchmarkSplitChunks2MB(b *testing.B) {
	payload := []byte(`{"id":"obu:1","params":{"blob":"` + strings.Repeat("Q", 2<<20) + `"}}`)
	b.SetBytes(int64(len(payload)))
	for i := 0; i < b.N; i++ {
		SplitChunks(payload, "obu:1")
	}
}

func BenchmarkReassemble2MB(b *testing.B) {
	payload := []byte(`{"id":"obu:1","params":{"blob":"` + strings.Repeat("Q", 2<<20) + `"}}`)
	frames := SplitChunks(payload, "obu:1")
	b.SetBytes(int64(len(payload)))
	for i := 0; i < b.N; i++ {
		r := NewReassembler()
		for _, f := range frames {
			if _, err := r.Add(f); err != nil {
				b.Fatal(err)
			}
		}
	}
}
