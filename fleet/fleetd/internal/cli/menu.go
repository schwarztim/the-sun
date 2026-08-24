package cli

import (
	"fmt"
	"os"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"mcp-fleet/fleetd/internal/fleet"
	"mcp-fleet/fleetd/internal/manifest"
)

// runMenu launches the interactive dashboard (server list view).
func runMenu(args []string) int {
	return runMenuModel(newModel(), args)
}

// runMenuCreds launches the interactive dashboard directly in the secrets/auth
// view — this is what `thesun secrets` (no args) runs, promoting the view
// that used to require `menu` then pressing `c` to a first-class entry point.
func runMenuCreds(args []string) int {
	return runMenuModel(newCredsModel(), args)
}

// runMenuModel drives the given initial model. With no controlling TTY (piped,
// cron, CI) an interactive program is meaningless, so it degrades to `fleetd
// list` — the same data, non-interactively.
func runMenuModel(m model, args []string) int {
	if !isTTY() {
		fmt.Fprintln(os.Stderr, "fleetd: no TTY — falling back to `fleetd list`")
		return runList(args)
	}
	// Fail fast with a clear message if the daemon is unreachable.
	if _, err := fleet.SendControl(fleet.Request{Cmd: "status"}); err != nil {
		fmt.Fprintf(os.Stderr, "fleetd: %v\n", err)
		return 1
	}
	p := tea.NewProgram(m, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "fleetd: menu: %v\n", err)
		return 1
	}
	return 0
}

func isTTY() bool {
	fi, err := os.Stdout.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}

// ---- styles ----

var (
	titleStyle  = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("15")).Background(lipgloss.Color("63")).Padding(0, 1)
	headerStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("245"))
	selStyle    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("15")).Background(lipgloss.Color("236"))
	helpStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("241"))
	statusStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("214"))
	greenStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("42"))
	yellowStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("214"))
	redStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("196"))
	greyStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("244"))
)

func stateStyle(state string) lipgloss.Style {
	switch state {
	case fleet.StateRunning:
		return greenStyle
	case fleet.StateDegraded:
		return redStyle
	case fleet.StateStarting:
		return yellowStyle
	default:
		return greyStyle
	}
}

// ---- messages ----

type rowsMsg struct {
	rows []row
	err  error
}
type actionDoneMsg struct {
	label string
	err   error
}
type tickMsg time.Time

func fetchCmd() tea.Cmd {
	return func() tea.Msg {
		rows, err := fetchRows()
		return rowsMsg{rows: rows, err: err}
	}
}

func tickCmd() tea.Cmd {
	return tea.Tick(2*time.Second, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func controlCmd(cmd, server, label string) tea.Cmd {
	return func() tea.Msg {
		resp, err := fleet.SendControl(fleet.Request{Cmd: cmd, Server: server})
		if err == nil && resp != nil && !resp.OK && resp.Error != "" {
			err = fmt.Errorf("%s", resp.Error)
		}
		return actionDoneMsg{label: label, err: err}
	}
}

// ---- model ----

type mode int

const (
	modeList mode = iota
	modeLogs
	modeConfirmRM
	modeCreds
	modeInput
)

type model struct {
	rows    []row
	cursor  int
	mode    mode
	status  string
	logName string
	logBody string
	err     string
	width   int
	height  int

	// Secrets/Auth view (Hermes).
	credRows   []credRow
	credCursor int

	// Inline non-secret text input (e.g. account name before a secret-safe
	// Hermes hand-off). The secret value itself is never captured here.
	inputPrompt string
	inputBuf    string
	inputAction func(string) tea.Cmd
	inputReturn mode // mode to return to on cancel
}

func newModel() model { return model{status: "loading…"} }

// newCredsModel starts the dashboard directly in the secrets/auth view (see
// runMenuCreds) instead of the server list.
func newCredsModel() model {
	m := newModel()
	m.mode = modeCreds
	m.status = "loading auth…"
	return m
}

func (m model) Init() tea.Cmd {
	if m.mode == modeCreds {
		// Load creds rows for the initial view, and list rows in the background
		// so `esc`/`c` back to the server list is instant, not a fresh fetch.
		return tea.Batch(fetchCredsCmd(), fetchCmd(), tickCmd())
	}
	return tea.Batch(fetchCmd(), tickCmd())
}

func (m model) current() (row, bool) {
	if m.cursor >= 0 && m.cursor < len(m.rows) {
		return m.rows[m.cursor], true
	}
	return row{}, false
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil

	case rowsMsg:
		if msg.err != nil {
			m.err = msg.err.Error()
			return m, nil
		}
		m.err = ""
		m.rows = msg.rows
		if m.status == "loading…" {
			m.status = ""
		}
		if m.cursor >= len(m.rows) {
			m.cursor = max(0, len(m.rows)-1)
		}
		return m, nil

	case credsMsg:
		if msg.err != nil {
			m.err = msg.err.Error()
			return m, nil
		}
		m.err = ""
		m.credRows = msg.rows
		if m.status == "loading auth…" {
			m.status = ""
		}
		if m.credCursor >= len(m.credRows) {
			m.credCursor = max(0, len(m.credRows)-1)
		}
		return m, nil

	case tickMsg:
		// Periodic refresh only while viewing a live table.
		switch m.mode {
		case modeList:
			return m, tea.Batch(fetchCmd(), tickCmd())
		case modeCreds:
			return m, tea.Batch(fetchCredsCmd(), tickCmd())
		}
		return m, tickCmd()

	case actionDoneMsg:
		if msg.err != nil {
			m.status = statusStyle.Render("✖ " + msg.label + ": " + msg.err.Error())
		} else {
			m.status = greenStyle.Render("✔ " + msg.label)
		}
		return m, fetchCmd()

	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

// beginInput enters the inline text-input overlay to collect a non-secret value
// (e.g. an account name) before a secret-safe Hermes hand-off.
func (m *model) beginInput(prompt string, action func(string) tea.Cmd) {
	m.inputReturn = m.mode
	m.mode = modeInput
	m.inputPrompt = prompt
	m.inputBuf = ""
	m.inputAction = action
}

func (m model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	// Overlay modes first.
	switch m.mode {
	case modeCreds:
		return m.handleCredsKey(msg)
	case modeInput:
		return m.handleInputKey(msg)
	case modeLogs:
		if msg.String() == "esc" || msg.String() == "q" || msg.String() == "l" {
			m.mode = modeList
		}
		return m, nil
	case modeConfirmRM:
		switch msg.String() {
		case "y", "Y":
			cur, ok := m.current()
			m.mode = modeList
			if ok {
				m.status = "removing " + cur.Name + "…"
				return m, rmCmd(cur.Name)
			}
		case "n", "N", "esc":
			m.mode = modeList
			m.status = "rm cancelled"
		}
		return m, nil
	}

	// List mode.
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < len(m.rows)-1 {
			m.cursor++
		}
	case "g", "home":
		m.cursor = 0
	case "G", "end":
		m.cursor = max(0, len(m.rows)-1)
	case "s":
		if cur, ok := m.current(); ok {
			m.status = "starting " + cur.Name + "…"
			return m, controlCmd("start", cur.Name, "start "+cur.Name)
		}
	case "x":
		if cur, ok := m.current(); ok {
			m.status = "stopping " + cur.Name + "…"
			return m, controlCmd("stop", cur.Name, "stop "+cur.Name)
		}
	case "r":
		if cur, ok := m.current(); ok {
			m.status = "restarting " + cur.Name + "…"
			return m, controlCmd("restart", cur.Name, "restart "+cur.Name)
		}
	case "R":
		m.status = "refreshing…"
		return m, fetchCmd()
	case "D":
		if _, ok := m.current(); ok {
			m.mode = modeConfirmRM
		}
	case "l", "enter":
		if cur, ok := m.current(); ok {
			m.logName = cur.Name
			m.logBody = loadLogTail(cur.Name, 40)
			m.mode = modeLogs
		}
	case "o":
		if cur, ok := m.current(); ok {
			m.status = "url: " + cur.URL
		}
	case "c":
		m.mode = modeCreds
		m.status = "loading auth…"
		return m, fetchCredsCmd()
	}
	return m, nil
}

// handleInputKey drives the inline (non-secret) text input.
func (m model) handleInputKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.Type {
	case tea.KeyEnter:
		val := m.inputBuf
		action := m.inputAction
		m.mode = m.inputReturn
		m.inputBuf = ""
		m.inputAction = nil
		if action != nil {
			return m, action(val)
		}
		return m, nil
	case tea.KeyEsc:
		m.mode = m.inputReturn
		m.inputBuf = ""
		m.inputAction = nil
		m.status = "cancelled"
		return m, nil
	case tea.KeyBackspace, tea.KeyDelete:
		if len(m.inputBuf) > 0 {
			m.inputBuf = m.inputBuf[:len(m.inputBuf)-1]
		}
		return m, nil
	case tea.KeyRunes, tea.KeySpace:
		m.inputBuf += string(msg.Runes)
		return m, nil
	}
	return m, nil
}

func (m model) viewInput() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render(m.inputPrompt))
	b.WriteString("\n\n  ")
	b.WriteString(m.inputBuf + greenStyle.Render("▏"))
	b.WriteString("\n\n")
	b.WriteString(greyStyle.Render("  (account name — not secret. Hermes will prompt for the value securely.)\n"))
	b.WriteString(helpStyle.Render("  enter confirm · esc cancel"))
	return b.String()
}

// rmCmd edits the manifest to remove a server, then reloads the daemon.
func rmCmd(name string) tea.Cmd {
	return func() tea.Msg {
		if _, err := manifest.Remove(fleet.ManifestPath(), []string{name}); err != nil {
			return actionDoneMsg{label: "rm " + name, err: err}
		}
		resp, err := fleet.SendControl(fleet.Request{Cmd: "reload"})
		if err == nil && resp != nil && !resp.OK && resp.Error != "" {
			err = fmt.Errorf("%s", resp.Error)
		}
		return actionDoneMsg{label: "rm " + name, err: err}
	}
}

func loadLogTail(name string, n int) string {
	f, err := os.Open(fleet.LogFile(name))
	if err != nil {
		return "(no log: " + err.Error() + ")"
	}
	defer f.Close()
	lines, err := lastLines(f, n)
	if err != nil {
		return "(read error: " + err.Error() + ")"
	}
	if len(lines) == 0 {
		return "(log is empty)"
	}
	return strings.Join(lines, "\n")
}

func (m model) View() string {
	switch m.mode {
	case modeLogs:
		return m.viewLogs()
	case modeConfirmRM:
		return m.viewConfirm()
	case modeCreds:
		return m.viewCreds()
	case modeInput:
		return m.viewInput()
	default:
		return m.viewList()
	}
}

func (m model) viewList() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render("fleetd — MCP fleet dashboard"))
	b.WriteString("  ")
	b.WriteString(greyStyle.Render(fmt.Sprintf("%d server(s)", len(m.rows))))
	b.WriteString("\n\n")

	b.WriteString(headerStyle.Render(fmt.Sprintf("  %-16s %-6s %-8s %-9s %-9s %-8s %s", "NAME", "PORT", "PID", "STATE", "RESTARTS", "UPTIME", "URL")))
	b.WriteString("\n")

	if len(m.rows) == 0 {
		b.WriteString(greyStyle.Render("  (no servers)\n"))
	}
	for i, r := range m.rows {
		pid := "-"
		if r.PID > 0 {
			pid = fmt.Sprintf("%d", r.PID)
		}
		cursor := "  "
		if i == m.cursor {
			cursor = greenStyle.Render("▸ ")
		}
		line := fmt.Sprintf("%-16s %-6d %-8s %-9s %-9d %-8s %s",
			trunc(r.Name, 16), r.Port, pid, stateStyle(r.State).Render(fmt.Sprintf("%-9s", r.State)), r.Restarts, r.Uptime, r.URL)
		row := cursor + line
		if i == m.cursor {
			row = selStyle.Render(cursor+fmt.Sprintf("%-16s %-6d %-8s ", trunc(r.Name, 16), r.Port, pid)) +
				stateStyle(r.State).Render(fmt.Sprintf("%-9s ", r.State)) +
				selStyle.Render(fmt.Sprintf("%-9d %-8s %s", r.Restarts, r.Uptime, r.URL))
		}
		b.WriteString(row + "\n")
	}

	b.WriteString("\n")
	if m.err != "" {
		b.WriteString(redStyle.Render("daemon error: "+m.err) + "\n")
	}
	if m.status != "" {
		b.WriteString(m.status + "\n")
	}
	b.WriteString(helpStyle.Render("↑/↓ move · s start · x stop · r restart · D remove · l logs · o url · c creds/auth · R refresh · q quit"))
	return b.String()
}

func (m model) viewLogs() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render("logs: " + m.logName + " (last 40 lines)"))
	b.WriteString("\n\n")
	b.WriteString(m.logBody)
	b.WriteString("\n\n")
	b.WriteString(helpStyle.Render("esc/q back"))
	return b.String()
}

func (m model) viewConfirm() string {
	cur, _ := m.current()
	var b strings.Builder
	b.WriteString(titleStyle.Render("confirm remove"))
	b.WriteString("\n\n")
	b.WriteString(fmt.Sprintf("  Remove %s from the manifest and stop it?\n", redStyle.Render(cur.Name)))
	b.WriteString(greyStyle.Render("  (fleet.toml is backed up to fleet.toml.bak first)\n\n"))
	b.WriteString(helpStyle.Render("  y confirm · n cancel"))
	return b.String()
}

func trunc(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}
