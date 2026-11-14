#!/usr/bin/env node
/**
 * Compile the JDBC sidecar with the local JDK.
 *
 * The jar is a build artifact (not committed). When no JDK is present the step
 * degrades to a warning: the app then ships without JDBC support instead of
 * failing the whole packaging run. Set NETCATTY_REQUIRE_JDBC_SIDECAR=1 to make a
 * missing JDK an error instead (the packaging workflows do).
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "electron", "jdbc-sidecar", "src", "NetcattyJdbcSidecar.java");
const outDir = path.join(root, "dist", "jdbc-sidecar");
const classesDir = path.join(outDir, "classes");
const jarPath = path.join(outDir, "netcatty-jdbc-sidecar.jar");
const { resolveJava } = require(path.join(root, "electron", "bridges", "javaRuntime.cjs"));

function jdkHomeCandidates() {
  const homes = [];
  const java = resolveJava({});
  if (java.ok) {
    for (const tried of java.tried || []) {
      if (!tried.includes(path.sep)) continue;
      // tried entries are bin/java paths; keep the home even when the runtime
      // came from PATH so javac can be found next to it.
      homes.push(path.dirname(path.dirname(tried)));
    }
    if (java.path && java.path.includes(path.sep)) {
      homes.push(path.dirname(path.dirname(java.path)));
    }
  }
  if (process.env.JAVA_HOME) homes.push(process.env.JAVA_HOME);
  if (process.platform === "darwin") {
    for (const glob of ["/opt/homebrew/opt/openjdk@21", "/opt/homebrew/opt/openjdk@17"]) {
      homes.push(path.join(glob, "libexec", "openjdk.jdk", "Contents", "Home"));
    }
    const userJvms = path.join(process.env.HOME || "", "Library", "Java", "JavaVirtualMachines");
    try {
      for (const entry of fs.readdirSync(userJvms)) {
        homes.push(path.join(userJvms, entry, "Contents", "Home"));
      }
    } catch {
      // no per-user JDKs
    }
  }
  return homes;
}

function findJdkTool(name) {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const candidates = [];
  for (const home of jdkHomeCandidates()) {
    candidates.push(path.join(home, "bin", exe));
  }
  candidates.push(exe);
  for (const candidate of candidates) {
    try {
      if (!candidate.includes(path.sep)) {
        execFileSync(candidate, ["-version"], { stdio: "ignore" });
        return candidate;
      }
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function main() {
  if (process.env.NETCATTY_SKIP_JDBC_SIDECAR === "1") {
    console.log("[jdbc-sidecar] skipped via NETCATTY_SKIP_JDBC_SIDECAR=1");
    return;
  }
  const javac = findJdkTool("javac");
  const jar = findJdkTool("jar");
  if (!javac || !jar) {
    // Release pipelines set this: a package without the jar looks fine until
    // someone opens a JDBC connection and is told a file is missing.
    if (process.env.NETCATTY_REQUIRE_JDBC_SIDECAR === "1") {
      console.error("[jdbc-sidecar] javac/jar not found and NETCATTY_REQUIRE_JDBC_SIDECAR=1: install a JDK (17 or newer) on the build machine");
      process.exit(1);
    }
    console.warn("[jdbc-sidecar] javac/jar not found — JDBC support will be unavailable in this build");
    return;
  }
  fs.rmSync(classesDir, { recursive: true, force: true });
  fs.mkdirSync(classesDir, { recursive: true });
  // Target Java 17 so a machine with an older (but still supported) runtime can
  // execute the sidecar; class-file 65 would fail with UnsupportedClassVersionError.
  execFileSync(javac, ["-encoding", "UTF-8", "--release", "17", "-d", classesDir, source], {
    stdio: "inherit",
  });
  fs.rmSync(jarPath, { force: true });
  execFileSync(jar, ["cfe", jarPath, "NetcattyJdbcSidecar", "-C", classesDir, "."], { stdio: "inherit" });
  // Ship a copy next to jdbcSidecar.cjs so it lands inside app.asar: the packaged
  // app resolves the sidecar jar relative to the bridge directory.
  const packagedDir = path.join(root, "electron", "bridges", "jdbc-sidecar");
  fs.mkdirSync(packagedDir, { recursive: true });
  fs.copyFileSync(jarPath, path.join(packagedDir, path.basename(jarPath)));
  const size = fs.statSync(jarPath).size;
  console.log(`[jdbc-sidecar] built ${path.relative(root, jarPath)} (${size} bytes)`);
}

main();
