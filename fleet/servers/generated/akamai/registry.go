// Operation registry: the embedded catalog of every Akamai API operation this
// server can execute via akamai_raw_request. The catalog is generated once from
// the Akamai OpenAPI specs (github.com/akamai/akamai-apis) and embedded at build
// time, so there is no runtime spec-parsing dependency. Each entry carries the
// tool name, HTTP method, path template, and parameter metadata the universal
// executor needs to build a request.
package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

//go:embed registry.json
var registryJSON []byte

// paramDef is a single path or query parameter definition.
type paramDef struct {
	Name     string `json:"name"`
	Required bool   `json:"required"`
}

// operation is one executable Akamai API operation.
type operation struct {
	ToolName           string     `json:"toolName"`
	Product            string     `json:"product"`
	Method             string     `json:"method"`
	Path               string     `json:"path"`
	Summary            string     `json:"summary"`
	SupportsPagination bool       `json:"supportsPagination"`
	PathParameters     []paramDef `json:"pathParameters"`
	QueryParameters    []paramDef `json:"queryParameters"`
	HasBody            bool       `json:"hasBody"`
	BodyRequired       bool       `json:"bodyRequired"`
}

// registry is the in-memory index built from the embedded catalog.
type registry struct {
	ops        map[string]operation // by toolName
	byProduct  map[string][]string  // product -> toolNames
	byMethod   map[string][]string  // method -> toolNames
	orderedIDs []string             // stable-sorted toolNames
}

// loadRegistry parses the embedded catalog and builds lookup indexes.
func loadRegistry() (*registry, error) {
	var ops []operation
	if err := json.Unmarshal(registryJSON, &ops); err != nil {
		return nil, fmt.Errorf("failed to parse embedded registry: %w", err)
	}
	r := &registry{
		ops:       make(map[string]operation, len(ops)),
		byProduct: map[string][]string{},
		byMethod:  map[string][]string{},
	}
	for _, op := range ops {
		r.ops[op.ToolName] = op
		r.byProduct[op.Product] = append(r.byProduct[op.Product], op.ToolName)
		r.byMethod[strings.ToUpper(op.Method)] = append(r.byMethod[strings.ToUpper(op.Method)], op.ToolName)
		r.orderedIDs = append(r.orderedIDs, op.ToolName)
	}
	sort.Strings(r.orderedIDs)
	return r, nil
}

// get returns the operation for a tool name, if present.
func (r *registry) get(toolName string) (operation, bool) {
	op, ok := r.ops[toolName]
	return op, ok
}

// searchOpts filters the operation catalog.
type searchOpts struct {
	Product     string
	Method      string
	Query       string
	Paginatable *bool
	Limit       int
}

// searchResult is the lean projection returned by list_operations.
type searchResult struct {
	ToolName    string `json:"toolName"`
	Summary     string `json:"summary"`
	Method      string `json:"method"`
	Path        string `json:"path"`
	Product     string `json:"product"`
	Paginatable bool   `json:"paginatable"`
}

// search filters the catalog by the given options and returns lean projections.
func (r *registry) search(o searchOpts) (total int, results []searchResult) {
	limit := o.Limit
	if limit <= 0 {
		limit = 50
	}
	product := strings.ToLower(strings.TrimSpace(o.Product))
	method := strings.ToUpper(strings.TrimSpace(o.Method))
	q := strings.ToLower(strings.TrimSpace(o.Query))

	for _, id := range r.orderedIDs {
		op := r.ops[id]
		if product != "" && strings.ToLower(op.Product) != product {
			continue
		}
		if method != "" && strings.ToUpper(op.Method) != method {
			continue
		}
		if o.Paginatable != nil && op.SupportsPagination != *o.Paginatable {
			continue
		}
		if q != "" {
			hay := strings.ToLower(op.ToolName + " " + op.Summary + " " + op.Path)
			if !strings.Contains(hay, q) {
				continue
			}
		}
		total++
		if len(results) < limit {
			results = append(results, searchResult{
				ToolName:    op.ToolName,
				Summary:     op.Summary,
				Method:      op.Method,
				Path:        op.Path,
				Product:     op.Product,
				Paginatable: op.SupportsPagination,
			})
		}
	}
	return total, results
}

// stats returns coverage statistics over the whole catalog.
func (r *registry) stats() map[string]any {
	byProduct := map[string]int{}
	for p, ids := range r.byProduct {
		byProduct[p] = len(ids)
	}
	byMethod := map[string]int{}
	for m, ids := range r.byMethod {
		byMethod[m] = len(ids)
	}
	paginatable := 0
	withBody := 0
	for _, op := range r.ops {
		if op.SupportsPagination {
			paginatable++
		}
		if op.HasBody {
			withBody++
		}
	}
	return map[string]any{
		"totalOperations":       len(r.ops),
		"specsLoaded":           len(r.byProduct),
		"operationsByProduct":   byProduct,
		"operationsByMethod":    byMethod,
		"paginatableOperations": paginatable,
		"operationsWithBody":    withBody,
	}
}
