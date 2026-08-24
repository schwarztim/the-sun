package cli

// Secrets/Auth view for the `fleetd menu` dashboard. It shows Hermes auth
// services with color-coded session health + expiry and offers per-service
// actions that hand the terminal to Hermes (secret-safe): acquire an SSO
// session, enroll a credential (Hermes prompts for the value — fleetd never
// sees it), and remove a credential.

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type credRow struct {
	Service string
	Scheme  string
	Status  string
	Expires string // human ("in 2h", "expired 5m ago")
	EState  string // valid | expiring | expired | none
}

type credsMsg struct {
	rows []credRow
	err  error
}

func fetchCredsCmd() tea.Cmd {
	return func() tea.Msg {
		st, err := fetchHermesStatus()
		if err != nil {
			return credsMsg{err: err}
		}
		rows := make([]credRow, 0, len(st.Services))
		for _, s := range st.Services {
			exp := s.tokenExpiry()
			rows = append(rows, credRow{
				Service: s.Service,
				Scheme:  s.Scheme,
				Status:  s.Status,
				Expires: humanExpiry(exp),
				EState:  expiryState(exp),
			})
		}
		return credsMsg{rows: rows}
	}
}

// acquireCmd hands the terminal to `hermes acquire <svc>` for interactive SSO
// login, then resumes the TUI and refreshes.
func acquireCmd(service string) tea.Cmd {
	cmd, err := hermesExec("acquire", service)
	if err != nil {
		return func() tea.Msg { return actionDoneMsg{label: "acquire " + service, err: err} }
	}
	return tea.ExecProcess(cmd, func(err error) tea.Msg {
		return actionDoneMsg{label: "acquire " + service, err: err}
	})
}

// credSetCmd hands the terminal to `hermes creds set <svc> <acct>`; Hermes reads
// the secret via its own hidden prompt. The value never enters fleetd.
func credSetCmd(service, account string) tea.Cmd {
	cmd, err := hermesExec("creds", "set", service, account)
	if err != nil {
		return func() tea.Msg { return actionDoneMsg{label: "enroll " + service + "/" + account, err: err} }
	}
	return tea.ExecProcess(cmd, func(err error) tea.Msg {
		return actionDoneMsg{label: "enroll " + service + "/" + account, err: err}
	})
}

func credDeleteCmd(service, account string) tea.Cmd {
	cmd, err := hermesExec("creds", "delete", service, account)
	if err != nil {
		return func() tea.Msg { return actionDoneMsg{label: "rm-cred " + service + "/" + account, err: err} }
	}
	return tea.ExecProcess(cmd, func(err error) tea.Msg {
		return actionDoneMsg{label: "rm-cred " + service + "/" + account, err: err}
	})
}

func (m model) currentCred() (credRow, bool) {
	if m.credCursor >= 0 && m.credCursor < len(m.credRows) {
		return m.credRows[m.credCursor], true
	}
	return credRow{}, false
}

func (m model) handleCredsKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "c", "esc":
		m.mode = modeList
		return m, nil
	case "up", "k":
		if m.credCursor > 0 {
			m.credCursor--
		}
	case "down", "j":
		if m.credCursor < len(m.credRows)-1 {
			m.credCursor++
		}
	case "R":
		m.status = "refreshing auth…"
		return m, fetchCredsCmd()
	case "a":
		if cur, ok := m.currentCred(); ok {
			m.status = "acquiring " + cur.Service + "…"
			return m, acquireCmd(cur.Service)
		}
	case "e":
		if cur, ok := m.currentCred(); ok {
			// Collect the (non-secret) account name, then hand off to Hermes for
			// the secret value.
			m.beginInput("enroll: account name for "+cur.Service, func(acct string) tea.Cmd {
				if strings.TrimSpace(acct) == "" {
					return func() tea.Msg { return actionDoneMsg{label: "enroll", err: fmt.Errorf("account name required")} }
				}
				return credSetCmd(cur.Service, strings.TrimSpace(acct))
			})
		}
	case "d", "x":
		if cur, ok := m.currentCred(); ok {
			m.beginInput("remove: account name for "+cur.Service, func(acct string) tea.Cmd {
				if strings.TrimSpace(acct) == "" {
					return func() tea.Msg { return actionDoneMsg{label: "rm-cred", err: fmt.Errorf("account name required")} }
				}
				return credDeleteCmd(cur.Service, strings.TrimSpace(acct))
			})
		}
	}
	return m, nil
}

func (m model) viewCreds() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render("fleetd — auth & credentials (Hermes)"))
	b.WriteString("  ")
	b.WriteString(greyStyle.Render(fmt.Sprintf("%d service(s)", len(m.credRows))))
	b.WriteString("\n\n")

	b.WriteString(headerStyle.Render(fmt.Sprintf("  %-14s %-14s %-9s %s", "SERVICE", "SCHEME", "STATUS", "SESSION EXPIRES")))
	b.WriteString("\n")

	if m.err != "" {
		b.WriteString(redStyle.Render("hermes error: "+m.err) + "\n")
	}
	if len(m.credRows) == 0 && m.err == "" {
		b.WriteString(greyStyle.Render("  (loading auth status…)\n"))
	}
	for i, r := range m.credRows {
		cursor := "  "
		if i == m.credCursor {
			cursor = greenStyle.Render("▸ ")
		}
		st := credStateStyle(r.EState, r.Status)
		line := fmt.Sprintf("%-14s %-14s %s %s",
			trunc(r.Service, 14), trunc(r.Scheme, 14),
			st.Render(fmt.Sprintf("%-9s", r.Status)), st.Render(r.Expires))
		b.WriteString(cursor + line + "\n")
	}

	b.WriteString("\n")
	if m.status != "" {
		b.WriteString(m.status + "\n")
	}
	b.WriteString(helpStyle.Render("↑/↓ move · a acquire session · e enroll cred · d remove cred · R refresh · c servers · q quit"))
	return b.String()
}

// credStateStyle colours a row by expiry urgency, falling back to the textual
// status when there is no session token to age.
func credStateStyle(estate, status string) lipgloss.Style {
	switch estate {
	case "valid":
		return greenStyle
	case "expiring":
		return yellowStyle
	case "expired":
		return redStyle
	}
	// no token expiry — colour by status word
	switch status {
	case "healthy":
		return greenStyle
	case "degraded":
		return redStyle
	default:
		return greyStyle
	}
}
