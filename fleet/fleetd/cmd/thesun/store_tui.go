package main

// store_tui.go is the interactive MCP Store browser behind `thesun store`: a
// category-grouped catalog with live fuzzy filtering, honest trust badges,
// detail cards, and in-place install/remove. It reuses the bubbletea and
// lipgloss dependencies the fleet dashboard (internal/cli/menu.go) already
// vendors; no new dependency.
//
// Install goes through registryAdd, the one audited fail-closed path, with the
// process stdout/stderr temporarily captured to a pipe so the transcript lands
// in a result pane instead of corrupting the alt-screen. Remove mirrors the
// dashboard's rm primitive (manifest edit plus fleetd reload).

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"mcp-fleet/fleetd/internal/fleet"
	"mcp-fleet/fleetd/internal/manifest"
	"mcp-fleet/fleetd/internal/registry"
)

// ---- styles ----

var (
	stTitle     = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("15")).Background(lipgloss.Color("63")).Padding(0, 1)
	stHeader    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("111"))
	stSel       = lipgloss.NewStyle().Bold(true).Background(lipgloss.Color("236"))
	stHelp      = lipgloss.NewStyle().Foreground(lipgloss.Color("241"))
	stGrey      = lipgloss.NewStyle().Foreground(lipgloss.Color("244"))
	stGreen     = lipgloss.NewStyle().Foreground(lipgloss.Color("42"))
	stYellow    = lipgloss.NewStyle().Foreground(lipgloss.Color("214"))
	stRed       = lipgloss.NewStyle().Foreground(lipgloss.Color("196"))
	stCyan      = lipgloss.NewStyle().Foreground(lipgloss.Color("51"))
	stInstalled = lipgloss.NewStyle().Foreground(lipgloss.Color("42")).Bold(true)
)

func badgeStyle(level badgeLevel) lipgloss.Style {
	switch level {
	case badgeGood:
		return stGreen
	case badgeCaution:
		return stYellow
	default:
		return stRed
	}
}

// ---- messages ----

type storeIndexMsg struct {
	idx      *registry.Index
	warnings []string
	err      error
}

type storeInstalledMsg struct {
	names map[string]string
	err   error
}

// storeActionMsg is the outcome of an install or remove, with the captured
// transcript for the result pane.
type storeActionMsg struct {
	title  string
	output string
	ok     bool
}

// ---- commands ----

func fetchStoreIndexCmd(ref string) tea.Cmd {
	return func() tea.Msg {
		idx, warnings, err := registry.FetchIndexAuth(context.Background(), ref, bearerForURL(context.Background(), ref))
		return storeIndexMsg{idx: idx, warnings: warnings, err: err}
	}
}

func fetchInstalledCmd() tea.Cmd {
	return func() tea.Msg {
		names, err := installedServers()
		return storeInstalledMsg{names: names, err: err}
	}
}

// installStoreCmd runs the existing verified add path with output captured.
// The community flag maps to the CLI's --community consent, which the browser
// collects through an explicit confirmation first.
func installStoreCmd(name, ref string, community bool) tea.Cmd {
	return func() tea.Msg {
		args := []string{name, "--index", ref}
		if community {
			args = append(args, "--community")
		}
		code, out := captureOutput(func() int { return registryAdd(args) })
		title := "installed " + name
		if code != 0 {
			title = "install failed: " + name
		}
		return storeActionMsg{title: title, output: out, ok: code == 0}
	}
}

// removeStoreCmd removes an installed server: manifest edit plus fleetd
// reload, the same primitive the dashboard's rm uses.
func removeStoreCmd(name string) tea.Cmd {
	return func() tea.Msg {
		if _, err := manifest.Remove(fleet.ManifestPath(), []string{name}); err != nil {
			return storeActionMsg{title: "remove failed: " + name, output: err.Error(), ok: false}
		}
		out := "removed " + name + " from the manifest"
		resp, err := fleet.SendControl(fleet.Request{Cmd: "reload"})
		switch {
		case err != nil:
			out += "\nreload: " + err.Error() + " (fleetd not running? it will pick the change up on start)"
		case resp != nil && !resp.OK && resp.Error != "":
			out += "\nreload: " + resp.Error
		default:
			out += "\nfleet reloaded"
		}
		return storeActionMsg{title: "removed " + name, output: out, ok: true}
	}
}

// captureOutput runs fn with os.Stdout and os.Stderr redirected to a pipe and
// returns fn's exit code plus everything it printed. The bubbletea renderer
// holds its own handle to the real terminal (captured at program start), so
// swapping the package-level vars only affects fmt.Print* inside fn.
func captureOutput(fn func() int) (int, string) {
	r, w, err := os.Pipe()
	if err != nil {
		return fn(), "(output capture unavailable: " + err.Error() + ")"
	}
	origOut, origErr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = w, w
	done := make(chan string, 1)
	go func() {
		b, _ := io.ReadAll(r)
		done <- string(b)
	}()
	code := fn()
	os.Stdout, os.Stderr = origOut, origErr
	w.Close()
	out := <-done
	r.Close()
	return code, out
}

// ---- model ----

type storeMode int

const (
	storeBrowse storeMode = iota
	storeFilter
	storeDetail
	storeConfirm
	storeBusy
	storeResult
)

// storeRowKind distinguishes flattened display rows.
type storeRowKind int

const (
	rowCategory storeRowKind = iota
	rowEntry
)

type storeRow struct {
	kind  storeRowKind
	cat   string
	entry *registry.Entry
}

type storeModel struct {
	indexRef string
	tier     string
	query    string

	idx       *registry.Index
	warnings  []string
	installed map[string]string

	rows   []storeRow
	cursor int // index into rows; always on a rowEntry when any exist
	mode   storeMode
	status string
	err    string

	// pending action collected at confirm time
	pendingName      string
	pendingRemove    bool
	pendingCommunity bool
	confirmText      string

	resultTitle string
	resultBody  string
	resultOK    bool

	width, height int
}

func newStoreModel(ref, query, tier string) storeModel {
	return storeModel{
		indexRef:  ref,
		tier:      tier,
		query:     query,
		mode:      storeBusy,
		status:    "fetching catalog…",
		installed: map[string]string{},
	}
}

// runStoreTUI drives the interactive store. Callers guarantee a TTY.
func runStoreTUI(ref, query, tier string) int {
	p := tea.NewProgram(newStoreModel(ref, query, tier), tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "thesun store: %v\n", err)
		return 1
	}
	return 0
}

func (m storeModel) Init() tea.Cmd {
	return tea.Batch(fetchStoreIndexCmd(m.indexRef), fetchInstalledCmd())
}

// rebuild recomputes the flattened row list from the current filters and
// clamps the cursor onto an entry row.
func (m *storeModel) rebuild() {
	m.rows = m.rows[:0]
	if m.idx == nil {
		m.cursor = 0
		return
	}
	entries := filterStoreEntries(m.idx, m.query, m.tier)
	for _, cat := range groupByCategory(entries) {
		m.rows = append(m.rows, storeRow{kind: rowCategory, cat: cat.Name})
		for _, e := range cat.Entries {
			m.rows = append(m.rows, storeRow{kind: rowEntry, entry: e})
		}
	}
	if m.cursor >= len(m.rows) {
		m.cursor = len(m.rows) - 1
	}
	if m.cursor < 0 {
		m.cursor = 0
	}
	m.snapCursor(1)
}

// snapCursor moves the cursor in direction dir (+1/-1) until it rests on an
// entry row; if none exists in that direction it tries the other.
func (m *storeModel) snapCursor(dir int) {
	if len(m.rows) == 0 {
		m.cursor = 0
		return
	}
	for pass := 0; pass < 2; pass++ {
		for i := m.cursor; i >= 0 && i < len(m.rows); i += dir {
			if m.rows[i].kind == rowEntry {
				m.cursor = i
				return
			}
		}
		dir = -dir
	}
}

func (m *storeModel) moveCursor(dir int) {
	i := m.cursor + dir
	for i >= 0 && i < len(m.rows) {
		if m.rows[i].kind == rowEntry {
			m.cursor = i
			return
		}
		i += dir
	}
}

func (m storeModel) current() *registry.Entry {
	if m.cursor >= 0 && m.cursor < len(m.rows) && m.rows[m.cursor].kind == rowEntry {
		return m.rows[m.cursor].entry
	}
	return nil
}

func (m storeModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil

	case storeIndexMsg:
		if msg.err != nil {
			m.err = msg.err.Error()
			m.mode = storeBrowse
			m.status = ""
			return m, nil
		}
		m.err = ""
		m.idx = msg.idx
		m.warnings = msg.warnings
		if m.mode == storeBusy {
			m.mode = storeBrowse
		}
		m.status = ""
		m.rebuild()
		return m, nil

	case storeInstalledMsg:
		// A missing manifest just means nothing is installed yet; only surface
		// unexpected read errors.
		m.installed = msg.names
		if msg.err != nil && !os.IsNotExist(msg.err) {
			m.status = stGrey.Render("install state unavailable: " + msg.err.Error())
		}
		return m, nil

	case storeActionMsg:
		m.mode = storeResult
		m.resultTitle = msg.title
		m.resultBody = msg.output
		m.resultOK = msg.ok
		return m, fetchInstalledCmd()

	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

func (m storeModel) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	key := msg.String()

	switch m.mode {
	case storeBusy:
		if key == "ctrl+c" {
			return m, tea.Quit
		}
		return m, nil

	case storeFilter:
		switch msg.Type {
		case tea.KeyEnter:
			m.mode = storeBrowse
			return m, nil
		case tea.KeyEsc:
			m.query = ""
			m.mode = storeBrowse
			m.rebuild()
			return m, nil
		case tea.KeyBackspace, tea.KeyDelete:
			if len(m.query) > 0 {
				m.query = m.query[:len(m.query)-1]
				m.rebuild()
			}
			return m, nil
		case tea.KeyRunes, tea.KeySpace:
			m.query += string(msg.Runes)
			m.rebuild()
			return m, nil
		case tea.KeyUp:
			m.moveCursor(-1)
			return m, nil
		case tea.KeyDown:
			m.moveCursor(1)
			return m, nil
		case tea.KeyCtrlC:
			return m, tea.Quit
		}
		return m, nil

	case storeDetail:
		switch key {
		case "esc", "q", "enter":
			m.mode = storeBrowse
		case "i":
			return m.beginInstall()
		case "x":
			return m.beginRemove()
		case "ctrl+c":
			return m, tea.Quit
		}
		return m, nil

	case storeConfirm:
		switch key {
		case "y", "Y", "enter":
			m.mode = storeBusy
			if m.pendingRemove {
				m.status = "removing " + m.pendingName + "…"
				return m, removeStoreCmd(m.pendingName)
			}
			m.status = "installing " + m.pendingName + " (verifying sha256 + signature)…"
			return m, installStoreCmd(m.pendingName, m.indexRef, m.pendingCommunity)
		case "n", "N", "esc":
			m.mode = storeBrowse
			m.status = "cancelled"
		case "ctrl+c":
			return m, tea.Quit
		}
		return m, nil

	case storeResult:
		switch key {
		case "esc", "q", "enter":
			m.mode = storeBrowse
			m.status = ""
		case "ctrl+c":
			return m, tea.Quit
		}
		return m, nil
	}

	// storeBrowse
	switch key {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "up", "k":
		m.moveCursor(-1)
	case "down", "j":
		m.moveCursor(1)
	case "g", "home":
		m.cursor = 0
		m.snapCursor(1)
	case "G", "end":
		m.cursor = len(m.rows) - 1
		m.snapCursor(-1)
	case "/":
		m.mode = storeFilter
	case "esc":
		if m.query != "" {
			m.query = ""
			m.rebuild()
		}
	case "t":
		switch m.tier {
		case "":
			m.tier = "curated"
		case "curated":
			m.tier = "community"
		default:
			m.tier = ""
		}
		m.rebuild()
	case "enter", "l":
		if m.current() != nil {
			m.mode = storeDetail
		}
	case "i":
		return m.beginInstall()
	case "x":
		return m.beginRemove()
	case "R":
		m.status = "refreshing…"
		return m, tea.Batch(fetchStoreIndexCmd(m.indexRef), fetchInstalledCmd())
	}
	return m, nil
}

// beginInstall stages an install confirmation for the selected entry. The
// confirmation text is honest about tier: a community entry states the risk
// the --community flag expresses, and a curated entry that cannot pass the
// fail-closed gate is refused up front.
func (m storeModel) beginInstall() (tea.Model, tea.Cmd) {
	e := m.current()
	if e == nil {
		return m, nil
	}
	if _, ok := m.installed[e.Name]; ok {
		m.status = e.Name + " is already installed (x to remove)"
		return m, nil
	}
	v := e.Latest()
	b := badgeFor(e, v)
	if b.Level == badgeBad {
		m.status = stRed.Render("cannot install " + e.Name + ": " + b.Label)
		return m, nil
	}
	m.pendingName = e.Name
	m.pendingRemove = false
	m.pendingCommunity = !e.Curated()
	if e.Curated() {
		m.confirmText = fmt.Sprintf("Install %s? Verified install: sha256 + Ed25519 signature + lab gate, fail-closed.", e.Name)
	} else {
		m.confirmText = fmt.Sprintf("Install COMMUNITY entry %s? It is self-attested, NOT conformance-proven (same consent as the --community flag).", e.Name)
	}
	if v != nil && v.GatewayManifest.HasWrite {
		m.confirmText += " Its write tools will require Tier-B approval at the gateway."
	}
	m.mode = storeConfirm
	return m, nil
}

func (m storeModel) beginRemove() (tea.Model, tea.Cmd) {
	e := m.current()
	if e == nil {
		return m, nil
	}
	realName, ok := m.installed[e.Name]
	if !ok {
		m.status = e.Name + " is not installed"
		return m, nil
	}
	// Remove the name fleetd actually knows (a legacy "-go" server backs a bare
	// index entry), not the index entry name.
	m.pendingName = realName
	m.pendingRemove = true
	m.confirmText = fmt.Sprintf("Remove %s from the fleet manifest and stop it?", e.Name)
	m.mode = storeConfirm
	return m, nil
}

// ---- view ----

func (m storeModel) View() string {
	switch m.mode {
	case storeDetail:
		return m.viewDetail()
	case storeConfirm:
		return m.viewConfirm()
	case storeResult:
		return m.viewResult()
	default:
		return m.viewBrowse()
	}
}

func (m storeModel) tierLabel() string {
	if m.tier == "" {
		return "all tiers"
	}
	return m.tier
}

func (m storeModel) viewBrowse() string {
	var b strings.Builder
	entryCount := 0
	for _, r := range m.rows {
		if r.kind == rowEntry {
			entryCount++
		}
	}
	b.WriteString(stTitle.Render("thesun store"))
	b.WriteString("  ")
	b.WriteString(stGrey.Render(fmt.Sprintf("%d server(s) · %s · %s", entryCount, m.tierLabel(), m.indexRef)))
	b.WriteString("\n")

	if m.mode == storeFilter || m.query != "" {
		cursor := ""
		if m.mode == storeFilter {
			cursor = stGreen.Render("▏")
		}
		b.WriteString("  " + stCyan.Render("filter: ") + m.query + cursor + "\n")
	}
	b.WriteString("\n")

	var lines []string
	selLine := 0
	for i, r := range m.rows {
		if r.kind == rowCategory {
			lines = append(lines, stHeader.Render("  "+strings.ToUpper(r.cat)))
			continue
		}
		e := r.entry
		v := e.Latest()
		badge := badgeFor(e, v)
		state := stGrey.Render("○")
		if _, ok := m.installed[e.Name]; ok {
			state = stInstalled.Render("●")
		}
		tools := 0
		auth := "none"
		if v != nil {
			tools = v.LabReport.ToolCount
			auth = authLabel(v.Auth)
		}
		name := fmt.Sprintf("%-16s", trunc16(e.Name))
		meta := stGrey.Render(fmt.Sprintf("tools=%-3d %s · auth=%s", tools, safetyLabel(v), auth))
		line := fmt.Sprintf("  %s %s %s %s", state, name, badgeStyle(badge.Level).Render(badge.Glyph+" "+badge.Label), meta)
		if i == m.cursor {
			selLine = len(lines)
			line = stSel.Render("▸ ") + stSel.Render(name) + " " + badgeStyle(badge.Level).Render(badge.Glyph+" "+badge.Label) + " " + meta
			lines = append(lines, line)
			lines = append(lines, stGrey.Render("      "+e.Description))
			continue
		}
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		if m.status == "" && m.err == "" {
			lines = append(lines, stGrey.Render("  (no matching servers)"))
		}
	}

	// Window the list to the terminal height, keeping the selection visible.
	reserved := 6 // title + filter + blank + status/err + help
	if h := m.height - reserved; h > 3 && len(lines) > h {
		start := selLine - h/2
		if start < 0 {
			start = 0
		}
		if start+h > len(lines) {
			start = len(lines) - h
		}
		lines = lines[start : start+h]
	}
	b.WriteString(strings.Join(lines, "\n"))
	b.WriteString("\n\n")

	if m.err != "" {
		b.WriteString(stRed.Render("index error: "+m.err) + "\n")
	}
	for _, w := range m.warnings {
		b.WriteString(stYellow.Render("warning: "+w) + "\n")
	}
	if m.status != "" {
		b.WriteString(m.status + "\n")
	}
	b.WriteString(stHelp.Render("↑/↓ move · / filter · t tier · enter details · i install · x remove · R refresh · q quit"))
	return b.String()
}

func (m storeModel) viewDetail() string {
	e := m.current()
	if e == nil {
		return "(nothing selected)"
	}
	v := e.Latest()
	badge := badgeFor(e, v)

	var b strings.Builder
	b.WriteString(stTitle.Render("store: " + e.Name))
	b.WriteString("\n\n")
	b.WriteString("  " + e.Description + "\n\n")

	kv := func(k, val string) {
		b.WriteString(fmt.Sprintf("  %-12s %s\n", stHeader.Render(k), val))
	}
	kv("trust", badgeStyle(badge.Level).Render(badge.Glyph+" "+badge.Label))
	state := "available"
	if _, ok := m.installed[e.Name]; ok {
		state = stInstalled.Render("installed")
	}
	kv("state", state)
	kv("category", categoryName(e))
	if len(e.Tags) > 0 {
		kv("tags", strings.Join(e.Tags, ", "))
	}
	kv("maintainer", e.Maintainer)
	if e.Source != "" {
		kv("source", e.Source)
	}
	if v == nil {
		kv("version", stRed.Render("none released"))
	} else {
		kv("version", v.Version+" ("+v.Status+")")
		kv("tools", fmt.Sprintf("%d · %s", v.LabReport.ToolCount, safetyLabel(v)))
		kv("transport", v.LabReport.Transport)
		kv("auth", authDetail(v.Auth))
		if len(v.LabReport.Gates) > 0 {
			kv("lab gates", strings.Join(v.LabReport.Gates, ", "))
		}
		if len(v.LabReport.ResidualUnverifiedSurface) > 0 {
			kv("unverified", stYellow.Render(strings.Join(v.LabReport.ResidualUnverifiedSurface, ", ")))
		}
		var plats []string
		for _, p := range v.Platforms {
			plats = append(plats, p.OS+"/"+p.Arch)
		}
		if len(plats) > 0 {
			kv("platforms", strings.Join(plats, ", "))
		}
	}
	b.WriteString("\n")
	if m.status != "" {
		b.WriteString("  " + m.status + "\n")
	}
	b.WriteString(stHelp.Render("  i install · x remove · esc back"))
	return b.String()
}

// authDetail renders the credential contract for the detail card: what scheme
// the server needs and which Hermes service enrolls it. Values never appear.
func authDetail(a registry.Auth) string {
	if a.AuthScheme == "" || a.AuthScheme == "none" {
		return "none required"
	}
	s := a.AuthScheme
	if a.HermesService != "" {
		s += " · enroll: thesun acquire " + a.HermesService
	}
	return s
}

func (m storeModel) viewConfirm() string {
	var b strings.Builder
	b.WriteString(stTitle.Render("confirm"))
	b.WriteString("\n\n  ")
	b.WriteString(m.confirmText)
	b.WriteString("\n\n")
	b.WriteString(stHelp.Render("  y confirm · n cancel"))
	return b.String()
}

func (m storeModel) viewResult() string {
	var b strings.Builder
	title := stGreen.Render("✔ " + m.resultTitle)
	if !m.resultOK {
		title = stRed.Render("✖ " + m.resultTitle)
	}
	b.WriteString(stTitle.Render("store"))
	b.WriteString("\n\n  " + title + "\n\n")
	body := strings.TrimSpace(m.resultBody)
	if body == "" {
		body = "(no output)"
	}
	for _, line := range strings.Split(body, "\n") {
		b.WriteString("  " + line + "\n")
	}
	b.WriteString("\n")
	b.WriteString(stHelp.Render("  enter/esc back to the catalog"))
	return b.String()
}

func trunc16(s string) string {
	if len(s) <= 16 {
		return s
	}
	return s[:15] + "…"
}
