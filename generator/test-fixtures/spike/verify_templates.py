import asyncio, json, os, sys, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src" / "templates" / "python"))

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        b=json.dumps({k.lower():v for k,v in self.headers.items()}).encode()
        self.send_response(200); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self,*a): pass

async def test_http():
    import http_client as hc
    srv=HTTPServer(("127.0.0.1",0),H); port=srv.server_address[1]
    threading.Thread(target=srv.serve_forever,daemon=True).start()
    want=os.environ.get("THESUN_BROWSER_PLATFORM","(host)")
    client=hc.build_http_client(f"http://127.0.0.1:{port}")
    r=await client.get("/x"); seen=r.json()
    ua=seen.get("user-agent",""); plat=seen.get("sec-ch-ua-platform","")
    await client.aclose(); srv.shutdown()
    ident=hc.BROWSER_IDENTITY["platform"]
    ua_os = "Mac" if "Macintosh" in ua else "Windows" if "Windows" in ua else "Linux" if "Linux" in ua else "?"
    consistent = ua_os.lower()[:3] in plat.lower() or (ua_os=="Mac" and "macos" in plat.lower())
    print(f"  platform req={want} resolved={ident}  UA-os={ua_os}  Sec-CH-Platform={plat}  CONSISTENT={consistent}")
    return consistent

async def test_ratelimit():
    import ratelimit as rl
    i=rl.parse_rate_limit_headers({"Retry-After":"2","X-RateLimit-Limit":"100","X-RateLimit-Remaining":"5"})
    assert i.retry_after_seconds==2.0 and i.limit==100, i
    lim=rl.AdaptiveRateLimiter(per_second=50, per_minute=1000, per_day=100000, max_concurrency=4)
    for _ in range(3):
        await lim.acquire(); lim.release()
    calls={"n":0}
    class FakeResp:
        def __init__(s,code,hdrs): s.status_code=code; s.headers=hdrs
    class FakeClient:
        async def request(s,m,u,**k):
            calls["n"]+=1
            return FakeResp(200,{}) if calls["n"]>1 else FakeResp(429,{"Retry-After":"0"})
    r=await rl.request_with_backoff(FakeClient(),"GET","/x",lim)
    ok = r.status_code==200 and calls["n"]==2
    print(f"  ratelimit: header-parse OK, multi-window acquire OK, 429->retry->200 OK (calls={calls['n']}) PASS={ok}")
    return ok

async def test_auth():
    os.environ["THESUN_SERVICE"]="demo"; os.environ["DEMO_TOKEN"]="tok123"
    import importlib, auth as a; importlib.reload(a)
    h=await a.get_auth_headers()
    ok = h=={"Authorization":"Bearer tok123"}
    print(f"  auth: standalone bearer path -> {h} PASS={ok}")
    return ok

async def main():
    print("=== http_client wire test ===")
    a=await test_http()
    print("=== ratelimit ==="); b=await test_ratelimit()
    print("=== auth ==="); c=await test_auth()
    print("\nALL PASS:", a and b and c)
    sys.exit(0 if (a and b and c) else 1)
asyncio.run(main())
