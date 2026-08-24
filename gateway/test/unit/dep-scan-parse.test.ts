import { describe, it, expect } from "vitest";
import { parseInstallCommand } from "../../src/dep-scan/parse.js";

describe("parseInstallCommand — de-chaining", () => {
  it("finds the install after cd in a && chain", () => {
    expect(parseInstallCommand("cd /tmp && npm i lodash")).toEqual({
      ecosystem: "npm",
      packages: [{ name: "lodash" }],
    });
  });

  it("handles ; , | and newline separators", () => {
    expect(parseInstallCommand("echo hi ; pip install flask")).toEqual({
      ecosystem: "PyPI",
      packages: [{ name: "flask" }],
    });
    expect(parseInstallCommand("true | npm add axios")).toEqual({
      ecosystem: "npm",
      packages: [{ name: "axios" }],
    });
    expect(parseInstallCommand("ls\nnpm i react")).toEqual({
      ecosystem: "npm",
      packages: [{ name: "react" }],
    });
  });

  it("returns the FIRST install match in the chain", () => {
    expect(parseInstallCommand("npm i a && pip install b")).toEqual({
      ecosystem: "npm",
      packages: [{ name: "a" }],
    });
  });
});

describe("parseInstallCommand — leading wrappers", () => {
  it("strips sudo", () => {
    expect(parseInstallCommand("sudo npm i x")).toEqual({
      ecosystem: "npm",
      packages: [{ name: "x" }],
    });
  });

  it("strips env with inline assignments", () => {
    expect(parseInstallCommand("env FOO=1 BAR=2 pnpm add x")).toEqual({
      ecosystem: "npm",
      packages: [{ name: "x" }],
    });
  });

  it("strips bare VAR=VAL assignments", () => {
    expect(parseInstallCommand("FOO=1 npm i x")).toEqual({
      ecosystem: "npm",
      packages: [{ name: "x" }],
    });
  });

  it("strips time / command / nohup", () => {
    expect(parseInstallCommand("time npm i x")).toEqual({ ecosystem: "npm", packages: [{ name: "x" }] });
    expect(parseInstallCommand("command npm i x")).toEqual({ ecosystem: "npm", packages: [{ name: "x" }] });
    expect(parseInstallCommand("nohup pip install y")).toEqual({ ecosystem: "PyPI", packages: [{ name: "y" }] });
  });

  it("strips xargs and its flags", () => {
    expect(parseInstallCommand("xargs npm i lodash")).toEqual({
      ecosystem: "npm",
      packages: [{ name: "lodash" }],
    });
    expect(parseInstallCommand("xargs -r npm i lodash")).toEqual({
      ecosystem: "npm",
      packages: [{ name: "lodash" }],
    });
  });
});

describe("parseInstallCommand — redirections are not packages", () => {
  it("drops self-contained 2>&1", () => {
    expect(parseInstallCommand("npm i hono 2>&1")).toEqual({
      ecosystem: "npm",
      packages: [{ name: "hono" }],
    });
  });

  it("drops pure-operator redirection + its target", () => {
    expect(parseInstallCommand("npm i hono > out.log")).toEqual({
      ecosystem: "npm",
      packages: [{ name: "hono" }],
    });
    expect(parseInstallCommand("pip install flask 2>/dev/null")).toEqual({
      ecosystem: "PyPI",
      packages: [{ name: "flask" }],
    });
  });

  it("does NOT treat a version range spec as a redirection", () => {
    expect(parseInstallCommand("npm i hono@>=4.12")).toEqual({
      ecosystem: "npm",
      packages: [{ name: "hono", versionSpec: ">=4.12" }],
    });
  });
});

describe("parseInstallCommand — non-install subcommands → null", () => {
  it("npm ci / run / uninstall / remove → null", () => {
    expect(parseInstallCommand("npm ci")).toBeNull();
    expect(parseInstallCommand("npm run build")).toBeNull();
    expect(parseInstallCommand("npm uninstall lodash")).toBeNull();
    expect(parseInstallCommand("npm remove lodash")).toBeNull();
  });

  it("bare `npm install` with no packages → null", () => {
    expect(parseInstallCommand("npm install")).toBeNull();
    expect(parseInstallCommand("npm i")).toBeNull();
  });

  it("non-command text → null", () => {
    expect(parseInstallCommand("echo hello world")).toBeNull();
    expect(parseInstallCommand("")).toBeNull();
  });
});

describe("parseInstallCommand — pip operators", () => {
  it("splits >= into name + spec", () => {
    expect(parseInstallCommand("pip install flask>=2.0")).toEqual({
      ecosystem: "PyPI",
      packages: [{ name: "flask", versionSpec: ">=2.0" }],
    });
  });

  it("handles the full operator set", () => {
    expect(parseInstallCommand("pip3 install django==4.2")).toEqual({
      ecosystem: "PyPI",
      packages: [{ name: "django", versionSpec: "==4.2" }],
    });
    expect(parseInstallCommand("pip install numpy~=1.26")).toEqual({
      ecosystem: "PyPI",
      packages: [{ name: "numpy", versionSpec: "~=1.26" }],
    });
    expect(parseInstallCommand("pip install urllib3!=2.0")).toEqual({
      ecosystem: "PyPI",
      packages: [{ name: "urllib3", versionSpec: "!=2.0" }],
    });
  });

  it("python -m pip install", () => {
    expect(parseInstallCommand("python3 -m pip install requests")).toEqual({
      ecosystem: "PyPI",
      packages: [{ name: "requests" }],
    });
  });
});

describe("parseInstallCommand — npm scopes and @version", () => {
  it("splits scoped package on the LAST @", () => {
    expect(parseInstallCommand("npm i @scope/foo@1.2.3")).toEqual({
      ecosystem: "npm",
      packages: [{ name: "@scope/foo", versionSpec: "1.2.3" }],
    });
  });

  it("scoped package without version keeps the leading @", () => {
    expect(parseInstallCommand("npm i @scope/foo")).toEqual({
      ecosystem: "npm",
      packages: [{ name: "@scope/foo" }],
    });
  });

  it("plain @version", () => {
    expect(parseInstallCommand("npm i lodash@4.17.20")).toEqual({
      ecosystem: "npm",
      packages: [{ name: "lodash", versionSpec: "4.17.20" }],
    });
  });
});

describe("parseInstallCommand — skip non-package targets and flag values", () => {
  it("skips file:/URL/requirements.txt/wheels", () => {
    expect(parseInstallCommand("pip install ./local/pkg")).toBeNull();
    expect(parseInstallCommand("pip install https://example.com/x.whl")).toBeNull();
    expect(parseInstallCommand("pip install requirements.txt")).toBeNull();
    expect(parseInstallCommand("pip install /abs/path/pkg-1.0.tar.gz")).toBeNull();
    expect(parseInstallCommand("npm i git+https://github.com/a/b")).toBeNull();
  });

  it("skips value-taking flags with their values but keeps the package", () => {
    expect(parseInstallCommand("pip install --index-url https://pypi.org/simple flask")).toEqual({
      ecosystem: "PyPI",
      packages: [{ name: "flask" }],
    });
    expect(parseInstallCommand("npm i --registry https://r.example.com lodash")).toEqual({
      ecosystem: "npm",
      packages: [{ name: "lodash" }],
    });
  });

  it("skips boolean flags", () => {
    expect(parseInstallCommand("npm i lodash --save-dev -g")).toEqual({
      ecosystem: "npm",
      packages: [{ name: "lodash" }],
    });
  });
});

describe("parseInstallCommand — ecosystem matrix", () => {
  it("yarn/pnpm → npm", () => {
    expect(parseInstallCommand("yarn add left-pad")?.ecosystem).toBe("npm");
    expect(parseInstallCommand("pnpm add left-pad")?.ecosystem).toBe("npm");
  });

  it("poetry / uv add / uv pip install → PyPI", () => {
    expect(parseInstallCommand("poetry add flask")?.ecosystem).toBe("PyPI");
    expect(parseInstallCommand("uv add flask")?.ecosystem).toBe("PyPI");
    expect(parseInstallCommand("uv pip install flask")?.ecosystem).toBe("PyPI");
  });

  it("cargo add → crates.io", () => {
    expect(parseInstallCommand("cargo add serde")).toEqual({
      ecosystem: "crates.io",
      packages: [{ name: "serde" }],
    });
  });

  it("go get → Go (with module @version)", () => {
    expect(parseInstallCommand("go get github.com/pkg/errors@v0.9.1")).toEqual({
      ecosystem: "Go",
      packages: [{ name: "github.com/pkg/errors", versionSpec: "v0.9.1" }],
    });
  });

  it("gem install → RubyGems", () => {
    expect(parseInstallCommand("gem install rails")).toEqual({
      ecosystem: "RubyGems",
      packages: [{ name: "rails" }],
    });
  });

  it("multiple packages in one install", () => {
    expect(parseInstallCommand("npm i lodash axios react")).toEqual({
      ecosystem: "npm",
      packages: [{ name: "lodash" }, { name: "axios" }, { name: "react" }],
    });
  });
});
