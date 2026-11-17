package computer

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// The engine's server is JavaScript; these give its conversions where they reach an answer.

var (
	jsHex     = regexp.MustCompile(`^0[xX][0-9a-fA-F]+$`)
	jsOctal   = regexp.MustCompile(`^0[oO][0-7]+$`)
	jsBinary  = regexp.MustCompile(`^0[bB][01]+$`)
	jsDecimal = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)
)

// jsNumber is JavaScript's Number(s) of a string: whitespace trimmed, "" is 0, NaN when it isn't
// a number.
func jsNumber(s string) float64 {
	s = strings.TrimSpace(s)
	switch {
	case s == "":
		return 0
	case s == "Infinity" || s == "+Infinity":
		return math.Inf(1)
	case s == "-Infinity":
		return math.Inf(-1)
	case jsHex.MatchString(s), jsOctal.MatchString(s), jsBinary.MatchString(s):
		base := map[byte]int{'x': 16, 'X': 16, 'o': 8, 'O': 8, 'b': 2, 'B': 2}[s[1]]
		n, err := strconv.ParseUint(s[2:], base, 64)
		if err != nil {
			return math.NaN()
		}
		return float64(n)
	case jsDecimal.MatchString(s):
		f, err := strconv.ParseFloat(s, 64)
		if err != nil && !strings.Contains(err.Error(), "range") {
			return math.NaN()
		}
		return f
	}
	return math.NaN()
}

// jsNumberOf is Number(v) of a decoded JSON value.
func jsNumberOf(v any) float64 {
	switch x := v.(type) {
	case nil:
		return 0
	case float64:
		return x
	case bool:
		if x {
			return 1
		}
		return 0
	case string:
		return jsNumber(x)
	case []any:
		switch len(x) {
		case 0:
			return 0
		case 1:
			return jsNumberOf(jsStringOf(x[0]))
		}
	}
	return math.NaN()
}

// jsStringOf is String(v) (or a template literal's) of a decoded JSON value.
func jsStringOf(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return jsNumberString(x)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil {
				parts[i] = jsStringOf(e)
			}
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

// jsNumberString is how JavaScript prints a number.
func jsNumberString(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	abs := math.Abs(f)
	if abs >= 1e21 || abs < 1e-6 {
		s := strconv.FormatFloat(f, 'e', -1, 64)
		// Go writes e+21 and e-07; JavaScript e+21 and e-7.
		mantissa, exp, _ := strings.Cut(s, "e")
		sign := exp[0]
		exp = strings.TrimLeft(exp[1:], "0")
		return mantissa + "e" + string(sign) + exp
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// setTimeoutMs is the delay Node's setTimeout really waits for ms: 1 for anything that isn't a
// number from 1 to 2^31-1.
func setTimeoutMs(ms float64) float64 {
	if !(ms >= 1 && ms <= 2147483647) {
		return 1
	}
	return ms
}

// decodeUTF8 is Node's Buffer#toString("utf8"): each maximal invalid subpart becomes one U+FFFD
// (the WHATWG decoder), where Go's conversions would replace each byte.
func decodeUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	sb.Grow(len(b) + 16)
	for i := 0; i < len(b); {
		c := b[i]
		if c < utf8.RuneSelf {
			sb.WriteByte(c)
			i++
			continue
		}
		if r, size := utf8.DecodeRune(b[i:]); r != utf8.RuneError || size > 1 {
			sb.Write(b[i : i+size])
			i += size
			continue
		}
		need, lo, hi := 0, byte(0x80), byte(0xBF)
		switch {
		case c >= 0xC2 && c <= 0xDF:
			need = 1
		case c == 0xE0:
			need, lo = 2, 0xA0
		case c == 0xED:
			need, hi = 2, 0x9F
		case c >= 0xE1 && c <= 0xEF:
			need = 2
		case c == 0xF0:
			need, lo = 3, 0x90
		case c == 0xF4:
			need, hi = 3, 0x8F
		case c >= 0xF1 && c <= 0xF3:
			need = 3
		}
		n := 1
		for k := 0; k < need && i+n < len(b); k++ {
			if x := b[i+n]; x < lo || x > hi {
				break
			}
			n++
			lo, hi = 0x80, 0xBF
		}
		sb.WriteRune(utf8.RuneError)
		i += n
	}
	return sb.String()
}

// lessUTF16 is JavaScript's default sort order: by UTF-16 code units.
func lessUTF16(a, b string) bool {
	ua, ub := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}
