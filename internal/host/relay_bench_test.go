package host

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

// legacyRewrite is the pre-WS-B relay transform (full map decode + encode),
// kept here only to benchmark against.
func legacyRewrite(payload []byte, hostID string) []byte {
	var message map[string]any
	if err := json.Unmarshal(payload, &message); err != nil {
		panic(err)
	}
	message["id"] = hostID
	out, err := json.Marshal(message)
	if err != nil {
		panic(err)
	}
	return out
}

func spliceRewrite(payload []byte, hostID string) []byte {
	span, _, err := wire.FindKey(payload, "id")
	if err != nil {
		panic(err)
	}
	return wire.Splice(payload, span, []byte(strconv.Quote(hostID)))
}

var (
	smallMsg = []byte(`{"jsonrpc":"2.0","id":"obu:1","result":{"result":{"type":"string","value":"hello"}}}`)
	bigMsg   = []byte(`{"jsonrpc":"2.0","id":"obu:1","result":{"data":"` + strings.Repeat("iVBORw0KGgo", 2<<20/11) + `"}}`)
)

func BenchmarkRewriteLegacySmall(b *testing.B) {
	for i := 0; i < b.N; i++ {
		legacyRewrite(smallMsg, "x")
	}
}
func BenchmarkRewriteSpliceSmall(b *testing.B) {
	for i := 0; i < b.N; i++ {
		spliceRewrite(smallMsg, "x")
	}
}
func BenchmarkRewriteLegacy2MB(b *testing.B) {
	b.SetBytes(int64(len(bigMsg)))
	for i := 0; i < b.N; i++ {
		legacyRewrite(bigMsg, "x")
	}
}
func BenchmarkRewriteSplice2MB(b *testing.B) {
	b.SetBytes(int64(len(bigMsg)))
	for i := 0; i < b.N; i++ {
		spliceRewrite(bigMsg, "x")
	}
}
