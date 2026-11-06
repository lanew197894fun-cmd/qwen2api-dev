const { execSync } = require("child_process");
const os = require("os");

function getSysInfo() {
  const isWin = os.platform() === "win32";

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPct = Math.round((usedMem / totalMem) * 100);
  const cpuLoad = os.loadavg()[0].toFixed(2);
  const uptimeHr = Math.floor(os.uptime() / 3600);

  let diskPct = -1;
  let pingMs = -1;

  const run = (cmd, timeout = 5000) => {
    try {
      return execSync(cmd, { timeout, encoding: "utf8", stdio: "pipe" }).trim();
    } catch {
      return "";
    }
  };

  if (isWin) {
    // ── 磁碟使用率 (優先 wmic，備援 PowerShell Get-PSDrive) ──
    const raw = run(
      'wmic logicaldisk where DeviceID="C:" get Size,Freespace /format:csv 2>nul',
    );
    if (raw) {
      const lines = raw.split(/\r?\n/).filter(Boolean);
      if (lines.length >= 2) {
        const parts = lines[1].split(",");
        if (parts.length >= 3) {
          const size = parseFloat(parts[1]);
          const free = parseFloat(parts[2]);
          if (size > 0) diskPct = Math.round(((size - free) / size) * 100);
        }
      }
    }
    // wmic 不存在時 (Win11 新版本已移除)，改用 Get-PSDrive
    if (diskPct < 0) {
      const raw2 = run(
        'powershell -NoProfile -Command "(Get-PSDrive C).Used/(Get-PSDrive C).Used+(Get-PSDrive C).Free*100"',
      );
      if (raw2) {
        const m = raw2.match(/(\d+(?:\.\d+)?)/);
        if (m) diskPct = Math.round(parseFloat(m[1]));
      }
    }
    // 備援2: Get-CimInstance (最慢但最準)
    if (diskPct < 0) {
      const raw3 = run(
        'powershell -NoProfile -Command "$d=Get-CimInstance Win32_LogicalDisk -Filter DeviceID=\\"C:\\";[math]::Round(($d.Size-$d.FreeSpace)/$d.Size*100)"',
      );
      if (raw3) diskPct = parseInt(raw3, 10) || -1;
    }

    // ── 網路延遲 (ping, 比 Test-Connection 更穩定) ──
    const pong = run('ping -n 1 8.8.8.8 | findstr /R "time=.*ms"');
    if (pong) {
      const m = pong.match(/time[=<](\d+\.?\d*)\s*ms/i);
      if (m) pingMs = parseFloat(m[1]);
    }
  } else {
    // ── 磁碟使用率 (Linux) ──
    const raw = run("df / | tail -1 | awk '{print $5}'");
    if (raw) diskPct = parseInt(raw.replace("%", ""), 10) || -1;

    // ── 網路延遲 (Linux ping) ──
    const pong = run(
      "ping -c 1 -W 2 8.8.8.8 2>/dev/null | grep -oP 'time=\\K[\\d.]+'",
    );
    if (pong) pingMs = parseFloat(pong);
  }

  return {
    memTotalGb: (totalMem / 1024 / 1024 / 1024).toFixed(1),
    memUsedGb: (usedMem / 1024 / 1024 / 1024).toFixed(1),
    memPct,
    cpuLoad,
    uptimeHr,
    diskPct: diskPct >= 0 ? diskPct : "N/A",
    pingMs: pingMs >= 0 ? pingMs.toFixed(0) : "N/A",
  };
}

module.exports = { getSysInfo };
