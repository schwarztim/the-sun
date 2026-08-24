package camouflage

import "encoding/json"

// lsHandler mirrors the subset of a single LSHandlers plist entry this
// package cares about. The full plist has many more keys; encoding/json
// silently ignores what we don't declare.
type lsHandler struct {
	URLScheme string `json:"LSHandlerURLScheme"`
	RoleAll   string `json:"LSHandlerRoleAll"`
}

type lsHandlersDoc struct {
	Handlers []lsHandler `json:"LSHandlers"`
}

// parseDefaultHTTPHandler extracts the bundle identifier registered as the
// default handler for the "http" URL scheme from a `plutil -convert json`
// dump of com.apple.launchservices.secure.plist. Returns "" if the document
// is malformed or no "http" entry exists — both are normal, not errors (a
// machine that never changed its default browser via System Settings may
// have no override recorded here at all).
func parseDefaultHTTPHandler(plistJSON []byte) string {
	var doc lsHandlersDoc
	if err := json.Unmarshal(plistJSON, &doc); err != nil {
		return ""
	}
	for _, h := range doc.Handlers {
		if h.URLScheme == "http" && h.RoleAll != "" {
			return h.RoleAll
		}
	}
	return ""
}
