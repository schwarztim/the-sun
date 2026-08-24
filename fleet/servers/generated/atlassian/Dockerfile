# syntax=docker/dockerfile:1
# Multi-stage build → static CGO-free binary → distroless. Streamable-HTTP only.

FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
# CGO disabled → fully static binary that runs on scratch/distroless.
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w -X main.version=$(cat VERSION 2>/dev/null || echo docker)" \
    -o /out/atlassian-mcp .

# Distroless static: no shell, no libc, nonroot by default.
FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/atlassian-mcp /atlassian-mcp
# Bind on all interfaces inside the container so the port is reachable; the
# harness still REQUIRES MCP_PORT (no default) — set it at run time.
ENV MCP_HOST=0.0.0.0 \
    MCP_PORT=42015
EXPOSE 42015
USER nonroot:nonroot
ENTRYPOINT ["/atlassian-mcp"]
