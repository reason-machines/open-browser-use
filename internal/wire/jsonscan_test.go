package wire

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestFindKeyLocatesTopLevelValues(t *testing.T) {
	payload := []byte(` { "jsonrpc":"2.0", "params": {"id": "nested", "s": "a\"}\\"}, "id" : 42 , "method":"x"}`)
	span, ok, err := FindKey(payload, "id")
	if err != nil || !ok {
		t.Fatalf("FindKey: ok=%v err=%v", ok, err)
	}
	if got := string(payload[span.Start:span.End]); got != "42" {
		t.Fatalf("got %q", got)
	}
	out := Splice(payload, span, []byte(`"obu:1"`))
	var decoded map[string]any
	if err := json.Unmarshal(out, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["id"] != "obu:1" || decoded["params"].(map[string]any)["id"] != "nested" {
		t.Fatalf("splice broke payload: %s", out)
	}
}

func TestFindKeyValueKinds(t *testing.T) {
	for _, raw := range []string{`"s"`, `-1.5e3`, `null`, `true`, `{"a":[1,{"b":"]"}]}`, `[1,"}",3]`, `"esc\\\""`} {
		payload := []byte(`{"x":1,"id":` + raw + `,"y":2}`)
		span, ok, err := FindKey(payload, "id")
		if err != nil || !ok || string(payload[span.Start:span.End]) != raw {
			t.Fatalf("%s: span=%v ok=%v err=%v", raw, span, ok, err)
		}
	}
}

func TestFindKeyMissingAndMalformed(t *testing.T) {
	if _, ok, err := FindKey([]byte(`{"method":"ping"}`), "id"); ok || err != nil {
		t.Fatalf("missing: ok=%v err=%v", ok, err)
	}
	if _, ok, err := FindKey([]byte(`{}`), "id"); ok || err != nil {
		t.Fatalf("empty: ok=%v err=%v", ok, err)
	}
	for _, bad := range []string{`[]`, `{"id"`, `{"id":"unterminated}`, `{"a" 1}`, ``} {
		if _, _, err := FindKey([]byte(bad), "id"); err == nil {
			t.Fatalf("expected error for %q", bad)
		}
	}
}

func TestFindPathNested(t *testing.T) {
	payload := []byte(`{"id":1,"params":{"tabId":3,"timeoutMs":2500,"x":{"timeoutMs":1}}}`)
	span, ok, err := FindPath(payload, "params", "timeoutMs")
	if err != nil || !ok || string(payload[span.Start:span.End]) != "2500" {
		t.Fatalf("span=%v ok=%v err=%v", span, ok, err)
	}
}

func TestFindKeyLargeStringIsLinear(t *testing.T) {
	big := strings.Repeat("A", 4<<20)
	payload := []byte(`{"result":{"data":"` + big + `"},"id":"obu:9"}`)
	span, ok, err := FindKey(payload, "id")
	if err != nil || !ok || string(payload[span.Start:span.End]) != `"obu:9"` {
		t.Fatalf("span=%v ok=%v err=%v", span, ok, err)
	}
}
