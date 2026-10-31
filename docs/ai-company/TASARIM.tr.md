# AI şirketi — yerel öncelikli mimari ve veri modeli (tasarım taslağı)

Durum: **taslak, kodsuz** (Faz 0.1). Tarih: 2026-10-31. Dal: `design/ai-company-local`.
Dayanak: rakip analizi `scratch/2026-10-31-rakip-analizi/braavolabs/RAPOR.tr.md` ve plan `PLAN-ONERISI.tr.md` (YULAlab çalışma alanı, repo dışı).
Bu belge yetki üretmez. Ad, hazır ajan listesi, varsayılan modeller, fiyat ve "laptop kapalıyken" bulut seçeneği kurucu kararıdır (§12).

---

## 1. Amaç ve ilkeler

Braavolabs'ı kullanıcının kendi bilgisayarında çalışan bir AI çalışma ortamına çevirmek: sohbet, kodlama ajanı, zamanlanmış görevler ve "AI şirketi" (org şeması olan, ortak şirket bağlamını paylaşan ajan ekibi). Desktop, CLI ve mobil aynı özellikleri paralel alır.

İlkeler:

1. **Yerel öncelik.** Ajan döngüsü, zamanlayıcı, bellek ve veriler kullanıcının makinesinde. Bulut yalnız (a) mobil kumanda için relay ve (b) kullanıcının seçtiği bulut model sağlayıcısı çağrıları içindir. **Braavolabs bulutu ajan yürütmez** (kurucu kararı K4, 2026-10-31): laptop uyurken kaçan koşu uyanınca bir kez telafi edilir ve bildirilir (§6.3).
2. **Mobil = kumanda.** Mobil yürütmez; izler, onaylar, yön verir, sohbet eder. Yürütme desktop/CLI'nin bağlandığı yerel daemon'da.
3. **Tek çekirdek, iki depolama.** Ajan döngüsü, sağlayıcı katmanı ve şirket modeli tek bir ortak pakette; bulut sunucu Postgres ile, yerel daemon SQLite ile aynı çekirdeği kullanır. Bugün bu kod üç repoda kopya.
4. **Model tarafsızlığı.** 14 sağlayıcı (bugün platformda bağlı) + yerel modeller; ajan başına sağlayıcı, model ve efor.
5. **Güvenlik varsayılan açık.** OS sandbox, ağ kapalı başlar, alan adı allowlist, onay kapısı; para/gönderim her zaman onay (mevcut kural, değişmez).
6. **Dürüst bellek.** "Bağlam sınırı yok" teknik olarak mümkün değil; hedef "unutmayan şirket hafızası": katmanlı bellek + geri çağırma (§7).
7. **Pil ve maliyet bilinci.** Model yalnız gerektiğinde çağrılır (preflight, §6.4); ajan başına bütçe.

---

## 2. Bileşenler

```
Kullanıcının bilgisayarı
  braavo daemon  (launchd / systemd / Windows servis; tek süreç)
    ├─ core: ajan döngüsü, araç kayıt defteri, sağlayıcı istemcisi
    ├─ org: şirket, ajan, görev, onay
    ├─ scheduler: rutinler, preflight, telafi
    ├─ memory: çekirdek not, md hafıza, arşiv araması, konsolidasyon
    ├─ tools: MCP istemci, web, dosya/shell (sandbox), ACP dış ajanlar
    ├─ guard: sandbox, ağ politikası, onay, redaction, keyring
    ├─ api: loopback HTTP + SSE (oturum token'lı)
    └─ relay-bridge: giden bağlantıyla buluttaki relay'e ayna
  istemciler: desktop (Tauri), CLI/TUI (`braavo`), ileride Chrome eklentisi
Bulut (mevcut platform)
  relay (mevcut modules/relay) ⇄ mobil
  (bulutta ajan yürütme YOK — K4)
```

**Neden daemon:** zamanlanmış görevler ve uzun koşular arayüz kapalıyken sürmeli; desktop ve CLI aynı durumu görmeli; mobil tek bir uca bağlanmalı. Rakiplerin vardığı desen (Claude Code supervisor daemon, Codex app-server, OpenClaw/Hermes gateway, Paperclip server) bu.

**Dil ve paketleme önerisi (K8):** Node (≥24), CLI paketinin parçası (`braavo daemon start|stop|status|logs`). Desktop daemon'u sidecar olarak paketler ve yoksa başlatır. Gerekçe: platformdaki ajan döngüsü ve sağlayıcı kodu TypeScript; yeniden yazmadan taşınır. Sandbox Rust tarafında kalabilir (desktop `sandbox.rs`), daemon onu yardımcı ikili olarak çağırır; CLI-yalnız kurulumda `sandbox-exec`/`bwrap` doğrudan sarılır.

**K8 karşılaştırması (kurucu kararı için):**

| Ölçüt | A) Node daemon, CLI paketinin içinde; desktop sidecar olarak paketler (öneri) | B) Rust daemon, Tauri host'unun içinde (veya ondan ayrılmış Rust ikilisi) |
|---|---|---|
| Mevcut kodun yeniden kullanımı | Yüksek: ajan döngüsü (`claude.ts`), 14 sağlayıcı (`ai-client.ts`), onay/steering, relay protokolü, SSRF koruması zaten TypeScript; `@braavo/core` paketiyle doğrudan taşınır | Düşük: bunların hepsi Rust'a yeniden yazılır veya daemon içinde ayrıca Node gömülür; sandbox (`sandbox.rs`), PTY (`pty.rs`), CDP (`browser.rs`) ve onay token'ı (`action_scope.rs`) zaten Rust |
| CLI-yalnız kullanıcı | Doğal: `npm i -g @braavolabs/cli` daemon'u da getirir | Ayrı Rust ikilisi dağıtılmalı (npm'de platforma göre ikili paketler) veya CLI desktop'a bağımlı olur |
| Desktop dağıtımı | Node çalışma zamanı sidecar olarak paketlenir (+~40–60 MB, doğrulanmadı: hedef platformlarda ölçülmeli) veya tek dosyalı Node SEA ikilisi; imza/notary ikili başına | Tek uygulama ikilisi; ek çalışma zamanı yok; imza/notary tek ikili |
| Bellek / pil | Node süreci boşta tipik olarak onlarca MB (ölçülmeli); 60 sn tik için yeterli | Daha düşük boşta bellek ve CPU |
| Sandbox ve güvenlik | Rust yardımcı ikilisi (mevcut `sandbox.rs`) çağrılır veya `sandbox-exec`/`bwrap` doğrudan; bir süreç sınırı fazla | Sandbox, onay token'ı ve native dialog aynı süreçte; saldırı yüzeyi daha dar |
| Uygulama kapalıyken çalışma | launchd/systemd ajanı; desktop kapansa da sürer | Tauri süreci kapanınca durur (bugün PTY çocukları böyle); ayrı Rust servis ikilisi gerekir, yani B de pratikte "ayrı daemon" olur |
| Geliştirme hızı | Hızlı: mevcut test altyapısı (vitest), platformla aynı dil | Yavaş: Rust'ta yeniden yazım + iki dilde aynı mantık (sunucu TS, yerel Rust) |
| Sunucu ile tek çekirdek | Evet: aynı paket bulutta (Postgres) ve yerelde (SQLite) | Hayır: iki ayrı uygulama, davranış farkı riski |

Öneri A: ürünün çekirdeği zaten TypeScript ve "bulutta ve yerelde aynı çekirdek" ilkesi (§1.3) yalnız A ile korunur. B'nin güçlü yanları (sandbox, PTY, onay dialogu) A'da Rust yardımcı ikili olarak kullanılmaya devam eder. Karar verilmeden önce ölçülmesi gerekenler: sidecar Node boyutu ve boşta bellek (macOS arm64/x64, Windows, Linux).

**Uyku davranışı:** daemon uykuyu engellemez (pil). Uyanınca kaçırılan rutinler §6.3'e göre ele alınır. "Koşu sürerken uykuyu engelle" kullanıcı ayarı (Cursor, Zed deseni) isteğe bağlı.

---

## 3. Yerel dizin ve depolama

```
~/.braavo/
  config.json          (mevcut; apiUrl, token, tercih)
  braavo.db            SQLite (WAL): şirket, ajan, görev, koşu, sohbet, rutin, maliyet, FTS5
  memory/              git deposu; şirket hafızası markdown (Obsidian uyumlu)
    company.md
    departments/<slug>.md
    agents/<agentId>/core.md      (çekirdek not, §7.2)
    agents/<agentId>/notes/*.md
  runs/<runId>.jsonl   ham transkript (saklama süresi ayarlı, varsayılan 30 gün)
  watch/<routineId>/   preflight durum dosyaları (son anlık görüntü, hash)
  mcp.json             (mevcut)
  daemon/              pid, port, log, oturum token'ı (0600)
```

- Sırlar **asla** `braavo.db`'ye düz yazılmaz: OS keyring (macOS Keychain, Windows Credential Manager; Linux'ta Secret Service, yoksa mevcut 0600 dosya). DB'de yalnız referans (`keyRef`).
- Hassas metin sütunları (sohbet içeriği, bellek) için isteğe bağlı şifreleme: keyring'den alınan anahtarla uygulama düzeyi AES-256-GCM (K: varsayılan açık mı, PLAN 4.8).
- Desktop bugün localStorage'da tuttuğu sohbet geçmişini tek seferlik göçle `braavo.db`'ye taşır.

---

## 4. Veri modeli

Platform Prisma modelleriyle aynı adlar ve anlamlar korunur; yerelde SQLite tabloları. **Kalın** alanlar bugün platformda olmayan eklemeler.

### 4.1 Şirket ve ajan

| Tablo | Alanlar | Not |
|---|---|---|
| `company` | id, name, slug, mission (metin), status (DRAFT/ACTIVE/PAUSED/ARCHIVED), config (JSON), **monthlyBudgetUsd**, **cloudCompanyId** (senkron için, K10), createdAt, updatedAt | Platform `Company` |
| `agent` | id, companyId, name, role, title, systemPrompt, tools (JSON), autonomy (SUPERVISED/BALANCED/AUTONOMOUS), **reportsToAgentId** (null = şirket sahibine/insana bağlı), **provider** (AIProvider enum), **model**, **effort** (none/low/medium/high/max), **status** (§5.2), **budgetUsdMonthly**, **heartbeatRrule** (isteğe bağlı), **engine** (`native` \| `acp:<ad>` \| `process`), **avatar**, createdAt, updatedAt | Platform `Agent` + org alanları |
| `agent_version` | id, agentId, version, snapshot (JSON), changeSummary, createdBy, createdAt | Platform `AgentVersion` |
| `hire_request` | id, companyId, proposedByAgentId \| null, spec (JSON), status (PENDING/APPROVED/REJECTED), decidedAt | Yeni ajan işe alma onayı (§5.3) |

Platform'a geri taşıma: `Agent` modeline `reportsToAgentId`, `provider`, `effort`, `status`, `budgetUsdMonthly` eklenmesi ayrı bir migration olarak önerilir (kurucu onaylı deploy; Faz 2).

### 4.2 İş: hedef, görev, koşu

| Tablo | Alanlar | Not |
|---|---|---|
| `goal` | id, companyId, parentGoalId, title, description, status | Görev → hedef → şirket zinciri ("goal ancestry", Paperclip deseni) |
| `task` | id, companyId, goalId, title, body, **assigneeAgentId**, createdBy (`user` \| agentId \| routineId), status (OPEN/CLAIMED/RUNNING/WAITING_APPROVAL/DONE/FAILED/CANCELLED), priority, **lockedByRunId** (atomik sahiplenme), dueAt, createdAt, updatedAt | Pipeline'dan bağımsız tekil iş; bugün platformda yok |
| `run` | id, companyId, taskId \| null, pipelineId \| null, agentId, status (platform `RunStatus`), costUsd, budgetUsd, resumeCursor, startedAt, endedAt, **origin** (`manual`/`routine`/`delegate`/`chat`) | Platform `Run` |
| `run_step` | id, runId, agentId, turn, reasoning (zorunlu), inputTokens, outputTokens, transcriptRef | Platform `RunStep`; ham transkript `runs/<id>.jsonl` |
| `tool_call` | id, runStepId, tool, argsRedacted, resultSummary, risk, approvalId, durationMs | Platform `ToolCall` |
| `approval` | id, runId, type (SPEND/INPUT/EXTERNAL_CONTROL/HANDOFF/**HIRE**/**SANDBOX_ESCAPE**), payload, status, decidedBy (`desktop`/`cli`/`mobile`), decidedAt, expiresAt | Platform `Approval` + iki yeni tür |
| `steering_message` | id, runId, kind (INPUT/STEER), content, source, consumedAt | Platform `SteeringMessage` |
| `cost_event` | id, companyId, agentId, runId, provider, model, inputTokens, outputTokens, usd, at | Ajan/şirket/sağlayıcı kırılımı |
| `activity` | id, companyId, actor, verb, objectType, objectId, summary, at | Panelin "son aktivite" akışı |

### 4.3 Sohbet

| Tablo | Alanlar | Not |
|---|---|---|
| `conversation` | id, companyId \| null, agentId \| null, title, provider, model, effort, createdAt, updatedAt | null şirket/ajan = serbest sohbet |
| `message` | id, conversationId, role (user/assistant/tool/system), content, toolCallId, tokens, at | FTS5 sanal tablosu `message_fts` |

Bir ajanla sohbet o ajanın bağlamını (çekirdek not + şirket hafızası dilimi) kullanır; sohbetten "bunu görev yap" ile `task` açılır.

### 4.4 Rutin (zamanlanmış görev)

| Tablo | Alanlar |
|---|---|
| `routine` | id, companyId, agentId, name, prompt, **rrule** (RFC 5545), **timezone** (IANA), enabled, **preflight** (JSON: tür + ayarlar, §6.4), **delivery** (`inbox` \| `push` \| `silent-unless-change`), **catchUp** (`skip` \| `once`), **concurrency** (`skip-if-running` \| `queue`), **maxRunsPerDay**, **budgetUsdPerRun**, lastFiredAt, nextFireAt, createdBy |
| `routine_execution` | id, routineId, scheduledFor, firedAt, outcome (`ran` \| `no-change` \| `skipped-sleep` \| `skipped-running` \| `skipped-budget` \| `failed`), runId \| null, note |

`routine_execution` her denemeyi yazar (Hermes `executions.db` deseni); panelde "neden çalışmadı" sorusunun cevabı buradan gelir (Claude Desktop'ın atlanan koşu nedenini göstermesi gibi).

---

## 5. Org modeli

### 5.1 Hiyerarşi kuralları

- Her ajanın en fazla bir yöneticisi var (`reportsToAgentId`); kök düğümler şirket sahibine (insana) bağlı. Döngü yasak (yazarken kontrol).
- **Delegasyon** yalnız aşağı doğru: bir ajan doğrudan veya dolaylı astlarına `delegate(agentId, task)` ile görev verebilir. Platformdaki `HIERARCHICAL` pipeline'ın `delegate` aracı ve `maxDelegationDepth` (varsayılan 3) aynen kullanılır.
- **Raporlama** yukarı doğru: görev bitince sonuç özeti yöneticinin gelen kutusuna (activity + isteğe bağlı mesaj).
- **Eskalasyon:** bir ajan `ask_user` çağırdığında soru önce yöneticisine gider; yönetici ajan cevaplayamazsa veya ajan kökse insana (mobil push). Bu, kurucunun "ajan şirket bağlamına katılır, bağımsız çalışmaz" isteğinin mekanizması. Para/gönderim onayları **her zaman** insana gider; yönetici ajan onay veremez (ajanlar arası mesaj onay sayılmaz).

### 5.2 Ajan durumu (panelde görünen)

```
idle ──(görev/rutin/heartbeat)──► running ──► idle
running ──(ask_user / onay)──► waiting ──(cevap)──► running
running ──(hata)──► error ──(yeniden dene / insan)──► idle
herhangi ──(bütçe %100 / insan)──► paused ──(insan)──► idle
```

Durum `agent.status`'ta tutulur ve SSE ile yayınlanır. "Çalışıyor mu" sorusu = `running`; panel ayrıca o anki görev başlığını ve son araç çağrısını gösterir.

### 5.3 İşe alma

- İnsan panelden ajan ekler (şablondan veya serbest). Ajan da yeni ajan **önerebilir** (`propose_hire` aracı) → `hire_request` + `HIRE` onayı; insan onaylamadan ajan oluşmaz (Paperclip ve OpenClaw deseni).
- Yeni ajan şirketin `mission`'ını, bağlı olduğu departman hafızasını ve yöneticisinin hedeflerini bağlam olarak alır.

### 5.4 Model ve efor ataması

- Ajan başına `provider` + `model` + `effort`. Sağlayıcı anahtarı yoksa ajan `error` durumuna geçer ve panelde "anahtar eksik" gösterilir (bugünkü "sessizce varsayılana düşme" davranışı yerelde **yapılmaz**).
- Efor eşlemesi sağlayıcıya göre (PLAN 0.4): Anthropic extended thinking bütçesi/effort, OpenAI `reasoning_effort`, Gemini thinking budget, Groq/Cerebras `reasoning_effort` (destekleyen modellerde); desteklemeyen modelde efor yok sayılır ve panelde işaretlenir.
- Varsayılan önerisi (K3): yönetici/CEO ajan güçlü model + düşük-orta efor; uzman ajanlar ucuz/yerel model; kodlama ajanı güçlü model + yüksek efor.

---

## 6. Görev yürütme ve zamanlayıcı

### 6.1 Ajan döngüsü

Platformdaki `runProviderAgentLoop` (modules/agent/claude.ts) yerel porta taşınır; davranış aynı:

1. Bağlamı kur: sistem prompt + çekirdek not + şirket/departman hafıza dilimi + görev + hedef zinciri + (varsa) son konuşma.
2. Tur: model çağrısı → araç çağrıları (eşzamanlılık sınırlı) → her araç için guard (§8) → sonuçlar.
3. Her tur başında steering kuyruğunu boşalt (INPUT/STEER), kesme (interrupt) kontrolü, checkpoint.
4. Bütçe kontrolü (ajan ve koşu); aşımda `paused`.
5. Bağlam eşiğine yaklaşınca §7.4 flush + compaction.
6. Bitişte: görev durumu, maliyet, activity, yöneticiye rapor.

Tur sınırı varsayılan 10 (platform) → yerelde ajan başına ayarlı; uzun işler `goal` + ilerleme defteri (§7.6) ile turlara bölünür.

### 6.2 Tetikleyiciler

`manual` (insan) · `chat` (sohbetten görev) · `delegate` (yönetici ajan) · `routine` (zaman) · `heartbeat` (ajanın kendi periyodik uyanışı: gelen kutusunu ve atanmış görevleri kontrol eder) · ileride `event` (Gmail/Slack/GitHub/RSS, PLAN 5.4).

### 6.3 Zamanlayıcı semantiği

- **Tik:** 60 saniye (Hermes). `nextFireAt <= now` olan rutinler sıraya girer. RRULE + IANA saat dilimi; DST doğru (Devin deseni). Doğal dil girişi ("her hafta içi 09:00") RRULE'a çevrilip kullanıcıya gösterilerek kaydedilir.
- **Uyku/kapalı:** uyanınca son tik ile şimdi arasındaki kaçırılmış ateşlemeler için `catchUp`:
  - `skip`: hepsi `skipped-sleep` olarak yazılır;
  - `once` (varsayılan): yalnız **en son** kaçırılan bir kez çalışır (son 7 gün içindeyse), diğerleri `skipped-sleep`; kullanıcıya "uyurken kaçırılan X görevi şimdi çalıştı" bildirimi (Claude Desktop kuralı).
- **Eşzamanlılık:** aynı rutinin önceki koşusu sürüyorsa `skip-if-running` (varsayılan) → `skipped-running`. Küresel eşzamanlı koşu sınırı (varsayılan 3, pil modunda 1).
- **Jitter:** saatlik ve üstü rutinlere deterministik 0–5 dk kaydırma (aynı anda patlamayı önler).
- **Kaçak koruma:** rutin içinden yeni rutin oluşturulamaz (Hermes); `maxRunsPerDay` ve `budgetUsdPerRun` aşılırsa `skipped-budget`.
- **Taze oturum:** her rutin koşusu temiz bağlamla başlar; süreklilik yalnız bellek ve preflight durumu üzerinden.

### 6.4 Preflight (modelsiz ön kontrol)

Rutin modeli çağırmadan önce ucuz bir kontrol çalıştırır; değişiklik yoksa koşu açılmaz (`no-change`), model ücreti sıfır (Devin Preflight deseni). İlk türler:

| Tür | Ne yapar | Durum |
|---|---|---|
| `web-diff` | URL'yi çeker, HTML'i görünür metne indirger, normalize eder (boşluk, tarih/saat gürültüsü), önceki anlık görüntüyle karşılaştırır | `watch/<id>/last.txt` + hash |
| `web-price` | `web-diff` + fiyat kalıplarını (para birimi + sayı) çıkarıp yalnız fiyat değişince tetikler | çıkarılan fiyat listesi |
| `rss` | yeni öğe var mı | son görülen öğe kimlikleri |
| `script` | kullanıcı betiği (sandbox içinde, ağ allowlist'li); çıkış kodu 0 + stdout boş değil = tetikle | betiğin kendi durum dosyası |

Preflight çıktısı (fark özeti, eski/yeni fiyat) koşuya **güvenilmeyen içerik** olarak verilir (§8.3).

### 6.5 Teslim

- `inbox`: sonuç şirket gelen kutusuna (desktop/CLI/mobil "Scheduled" görünümü, okunmadı işaretli; Codex deseni).
- `push`: mobil push (relay üzerinden mevcut push altyapısı).
- `silent-unless-change`: preflight `no-change` ise hiçbir şey gönderilmez; değişince inbox + push.
- Teslimden önce çıktıya secret redaction (mevcut `redact()`).

---

## 7. Bellek ("unutmayan şirket hafızası")

### 7.1 Kapsam ağacı

`company` > `department` > `agent` (CrewAI scope deseni). Bir ajan okurken kendi kapsamı + üst kapsamlar; yazarken varsayılan kendi kapsamı, şirket kapsamına yazmak yönetici veya onay ister.

### 7.2 Çekirdek not

Ajan başına küçük, ajanın kendisinin düzenlediği metin (`memory/agents/<id>/core.md`, üst sınır ~1.000 token). Oturum başında **dondurulmuş anlık görüntü** olarak bağlama girer; oturum içinde değişirse bir sonraki oturumda görünür (prompt cache dostu; Hermes deseni). Sınır aşılınca araç hata döner, ajan konsolide eder.

### 7.3 Şirket hafızası (git'li markdown)

`memory/` bir git deposu: insan okur, düzenler, geri alır (Letta MemFS deseni). Her bellek yazımı bir commit (yazar = ajan adı). Obsidian ile açılabilir. Büyük yeniden düzenlemeden önce etiket.

### 7.4 Arşiv ve geri çağırma

- SQLite FTS5: mesajlar, görev sonuçları, bellek notları.
- Vektör: sqlite-vec (tercih, tek dosya) veya LanceDB; embedding yerel (Ollama) veya seçili sağlayıcı. Platformdaki "Voyage yoksa hash embedding" düşüşü yerelde yapılmaz; embedding yoksa yalnız FTS5.
- `recall(query, scope)` aracı hibrit arama (FTS5 + vektör), sonuçları kaynak bağlantısıyla döner.

### 7.5 Compaction ve flush

Bağlam eşiğine (modelin penceresinin ~%70'i) gelince: önce **sessiz flush turu** (ajana "kalıcı olması gerekenleri belleğe yaz" talimatı, kullanıcıya görünmez; OpenClaw), sonra eski turların özetlenmesi; özet + çekirdek not + açık görevler + son N tur bağlamda kalır. Ham transkript `runs/*.jsonl`'da durur, `recall` ile ulaşılır.

### 7.6 Görev ve ilerleme defteri

Yönetici/CEO ajanı uzun hedeflerde iki yapısal kayıt tutar (Microsoft Agent Framework Magentic deseni): **görev defteri** (olgular + plan) ve her turda **ilerleme defteri** (istek karşılandı mı, döngüde mi, ilerleme var mı, sıradaki ajan, talimat). Takılma sayacı eşiği aşınca yeniden plan. Astlar yalnız kendi dilimlerini görür; bağlam küçük kalır.

### 7.7 Gece konsolidasyonu

Boşta (ve şarjdayken) çalışan bakım işi: son günün notlarını gözden geçirir, tekrarları birleştirir, çelişkileri işaretler, çekirdek notlara terfi önerir (Letta sleeptime, OpenClaw dreaming; platformda zaten günlük konsolidasyon cron'u var). Güvenilmeyen içerikten (web) gelen adaylar otomatik terfi etmez.

### 7.8 Zamansal olgular (Faz 4.6)

İzleme ajanları için `fact(subject, predicate, value, validFrom, validTo, sourceRunId)` tablosu: "Rakip X / Pro planı fiyatı / 39 $ / 2026-10-20 / —". Yeni değer eskisinin `validTo`'sunu kapatır (Graphiti'nin bi-temporal fikri, gömülü veritabanı gerektirmeden).

---

## 8. Güvenlik modeli

### 8.1 Araç sınıfları ve varsayılan politika

| Sınıf | Örnek | Varsayılan |
|---|---|---|
| Okuma (yerel) | dosya oku, bellek oku, görev listele | izinli |
| Okuma (ağ) | web fetch, arama, RSS | izinli, alan adı allowlist + SSRF koruması (platform `lib/ssrf.ts` taşınır) |
| Yazma (yerel, çalışma alanı içi) | dosya yaz, git commit (worktree) | autonomy'ye göre |
| Shell | komut çalıştır | **sandbox içinde**, ağ kapalı; kapsam dışı istek = `SANDBOX_ESCAPE` onayı |
| Dış etki | e-posta, mesaj, form gönder, yayınla | **her zaman onay** |
| Para | satın alma, abonelik | **her zaman onay** (değişmez kural) |
| Org | işe alma, rutin oluşturma | onay (`HIRE`) / rutin içinden yasak |

Desktop'taki mevcut `classifyAction` (auto-allow / require-approval / deny), tek kullanımlık onay token'ı ve native dialog bu sınıflandırmanın uygulayıcısıdır; daemon aynı kuralları kullanır.

### 8.2 Sandbox ve ağ

- macOS Seatbelt, Linux bubblewrap (desktop `sandbox.rs` mevcut); yazma yalnız çalışma alanı + temp; ağ kapalı başlar.
- Ağ açılacaksa yerel proxy üzerinden alan adı allowlist'i (rutin başına: izleme ajanı yalnız izlediği alan adlarına).
- Windows: sandbox gelene kadar shell aracı kapalı (bugünkü fail-closed davranış korunur).

### 8.3 Prompt injection

- Web, e-posta, RSS, dosya içeriği ve preflight çıktısı modele `<untrusted source="…">…</untrusted>` sarmalıyla verilir; sistem prompt'u bu içerikteki talimatların uygulanmayacağını söyler.
- Görünmez karakterler (sıfır genişlikli, bidi denetim) ve HTML yorumları ayıklanır (Copilot deseni).
- Güvenilmeyen içerik okunduktan sonraki turda dış etki/para aracı çağrılırsa onay **zorunlu**, autonomy ne olursa olsun.
- Ajanlar arası mesajlar kullanıcı onayı sayılmaz; yalnız insan arayüzünden (desktop dialog, CLI onayı, mobil) gelen karar onaydır.
- Platformdaki "önceki adım çıktısının yayılımını sınırlama" kuralı (context-builder) korunur.

### 8.4 Platformun değişmez kuralları yerelde de geçerli

Repo `CLAUDE.md` "Non-negotiable rules" daemon'da aynen uygulanır:

- Her araç çağrısı `tool_call`'a, her adımın gerekçesi `run_step.reasoning`'e (boş olamaz), her CRUD/gönderim/karar `activity`'ye yazılır.
- Para dokunan eylem `approval` satırı olmadan çalışmaz.
- Bellek yaşam döngüsü candidate → approved → deprecated; doğrudan `approved` yazılmaz. Yerelde "2+ başarılı örnek" kuralı şirketler arası değil, aynı şirketteki bağımsız koşular arası sayılır (tek kullanıcılı yerel kurulumda şirketler arası veri yok). §7.7 konsolidasyonu yalnız **terfi önerir**; terfi bu kurala uyar.
- Beş risk-stop: hard stop, loop guard (≥5 ardışık hata koşuyu/rutini durdurur), cost anomaly (bütçenin %20 üstü koşu ortasında durur), spam guard (aynı hedefe ≥3 yanıtsız gönderim), brand violation. Rutinlerde loop guard rutini `paused` yapar ve bildirim gönderir.
- Kiracı yalıtımı (rule 10) yerelde tek kullanıcı olduğu için şirket yalıtımına dönüşür: her sorgu `companyId` taşır; bir şirketin ajanı başka şirketin verisini okuyamaz.

### 8.5 Yerel API güvenliği

- Yalnız loopback (`127.0.0.1`), rastgele port; `~/.braavo/daemon/token` (0600) ile Bearer; CORS kapalı (desktop webview'i için açık origin listesi).
- Mobil daemon'a doğrudan bağlanmaz; yalnız relay (giden bağlantı, mevcut owner-binding).

---

## 9. Yerel API sözleşmesi (taslak)

REST + SSE, `/v1` öneki. Relay'in `SessionEvent`/`ControlCommand` birleşimleriyle aynı adlandırma ve sınırlar (`MAX_TEXT_LEN` vb.), aynı zod şemaları ortak pakette.

| Uç | Amaç |
|---|---|
| `GET /v1/health` | daemon sürümü, uptime, tik durumu |
| `GET/POST /v1/companies`, `GET/PATCH /v1/companies/:id` | şirket |
| `GET /v1/companies/:id/org` | org ağacı (ajan + durum + model + efor + bütçe kullanımı) |
| `GET/POST /v1/agents`, `PATCH /v1/agents/:id`, `POST /v1/agents/:id/pause|resume` | ajan |
| `GET/POST /v1/tasks`, `POST /v1/tasks/:id/cancel` | görev |
| `GET /v1/runs/:id`, `POST /v1/runs/:id/steer`, `POST /v1/runs/:id/interrupt` | koşu ve yön verme |
| `GET /v1/approvals?status=PENDING`, `POST /v1/approvals/:id/decide` | onay |
| `GET/POST /v1/routines`, `PATCH /v1/routines/:id`, `POST /v1/routines/:id/run-now`, `GET /v1/routines/:id/executions` | zamanlanmış görev |
| `GET/POST /v1/conversations`, `POST /v1/conversations/:id/messages` (SSE akış yanıtı) | sohbet |
| `GET /v1/inbox`, `POST /v1/inbox/:id/read` | gelen kutusu |
| `GET /v1/memory/search?q=&scope=` | bellek arama |
| `GET /v1/costs?groupBy=agent|provider|day` | maliyet |
| `GET /v1/events` (SSE) | tek olay akışı: `agent.status`, `run.step`, `run.tool`, `approval.requested`, `routine.executed`, `inbox.new`, `message.delta` |

Relay köprüsü bu olay akışının redaksiyonlu alt kümesini buluta aynalar; mobilden gelen `steer/approve/reject/kill` komutları yerel uçlara çevrilir.

---

## 10. Yüzeylerin sorumlulukları

| Özellik | Desktop | CLI/TUI | Mobil |
|---|---|---|---|
| Sohbet | tam | `braavo chat` (REPL) | relay ile (yerel model telefondan) + bulut cascade |
| Şirket paneli | org şeması, ajan kartları, bütçe, onay, harcama, aktivite | `braavo company`, `agents --tree`, `tasks`, `costs` | org/durum/onay/harcama, ajana mesaj |
| Rutinler | oluştur/düzenle, geçmiş + atlanma nedeni | `braavo schedule add|ls|run|log` | gelen kutusu, push, duraklat/çalıştır |
| Kodlama | gömülü terminal + diff + checkpoint | `braavo code` | izle, diff oku, onayla |
| Yürütme | daemon (sidecar) | daemon | yok |

### 10.1 Desktop arayüz framework'ü (K9, teknik seçim)

Bugün desktop arayüzü framework'süz TypeScript: `src/ui.ts` 2.462 satır, elle DOM. Şirket paneli (org şeması, ajan kartları, canlı durum, gelen kutusu, rutin geçmişi, sohbet akışı) bu yapıyla sürdürülemez.

**Seçim: React 19 + Vite (mevcut) + zustand.** Gerekçe:
- **Ortak bilgi ve desen:** platform web arayüzü Next.js 15 + React 19, mobil React Native 0.81 + zustand. Üç yüzeyde aynı bileşen ve durum desenleri kullanılır; i18n (14 dil), tema ve erişilebilirlik kalıpları paylaşılır.
- **Mevcut çekirdek değişmez:** `governance.ts`, `relay-*.ts`, `keyvault.ts`, `mcp.ts` gibi framework'süz modüller saf TS olarak kalır; React yalnız sunum katmanı olur.
- **Kademeli geçiş:** yeni yüzeyler (önce Şirket paneli, sonra sohbet) React kökü olarak mevcut kabuğa bağlanır; eski yüzeyler tek tek taşınır. Büyük bir yeniden yazım gerekmez.
- **Test:** Vitest (mevcut) + Testing Library.

**Değerlendirilen alternatifler:**
- **Svelte 5 / Solid:** daha küçük paket, ama ekipte ve diğer iki yüzeyde karşılığı yok; masaüstü uygulamasında paket boyutu belirleyici değil.
- **Framework'süz devam:** canlı akışlı, çok panelli bir arayüzde durum yönetimi ve test maliyeti hızla büyür.

---

## 11. Uçtan uca örnek: rakip izleme ajanı

1. Kullanıcı panelde "Pazar analisti" şablonunu işe alır (yönetici: CEO ajan; model: yerel Ollama `qwen` veya Groq; efor: düşük).
2. "Rakiplerimi izle": üç URL, sıklık "her 6 saatte bir", teslim `silent-unless-change` + push.
3. Rutin her ateşlemede `web-price` preflight çalıştırır: sayfa çekilir, normalize edilir, fiyatlar çıkarılır. Değişiklik yoksa `no-change` yazılır, model çağrılmaz.
4. Fiyat 49 $ → 39 $ olunca koşu açılır; ajana fark `<untrusted>` sarmalıyla verilir; ajan kısa özet yazar, `fact` tablosuna yeni değeri kaydeder, kampanya metnini not eder.
5. Gelen kutusuna "X Pro planını %20 indirdi" düşer, mobil push gider; CEO ajanın sonraki heartbeat'inde bu bilgi şirket hafızasına (rakipler.md) işlenir.
6. Laptop uyurken kaçan ateşlemeler: uyanınca bir telafi koşusu (son 7 gün), kullanıcıya bildirim.

Maliyet: değişiklik olmayan günlerde 0 model çağrısı. Faz 0.5 CLI prototipi adım 3'ü (preflight + defter) gerçekler.

---

## 12. Açık kararlar

Kurucu kararları `PLAN-ONERISI.tr.md` K1–K13'te. Bu tasarımı doğrudan etkileyenler:

| # | Karar | Tasarımdaki varsayılan (karar gelene kadar) |
|---|---|---|
| K1 | Bölümün adı | Çalışma adı "AI şirketi" / `company` |
| K2 | Hazır ajan listesi | Şablon mekanizması tasarlandı, liste boş |
| K3 | Varsayılan modeller | Yerel Ollama + BYOK; anahtar yoksa ajan `error` |
| K4 | Laptop kapalıyken bulut düğüm | **Karar (2026-10-31): bulut düğümü yok.** Yalnız yerel + `catchUp: once` + bildirim. `braavo daemon --headless` kullanıcının kendi makinesinde (ör. kendi Mac mini'si) çalışabilir; Braavolabs bulutu ajan yürütmez |
| K6 | Paperclip ile ilişki | Kendi şeması, Paperclip kavramlarına yakın (goal ancestry, heartbeat, bütçe, işe alma onayı) |
| K8 | Daemon dili | **Karar (2026-10-31): Node**, CLI paketinin parçası; desktop sidecar olarak paketler |
| K9 | Desktop arayüz framework'ü | **Teknik seçim: React 19 + Vite + zustand** (§10.1) |
| K1, K2 | Bölüm adı, ilk hazır ajan seti | Öneri §14 ve `scratch/2026-10-31-rakip-analizi/braavolabs/ONERI-AD-VE-AJANLAR.tr.md`; karar kurucuda |
| K10 | Bulut ↔ yerel senkron | Yok; `cloudCompanyId` alanı ileriye dönük |
| K11 | ACP ile dış ajan çıktısını okuma | Kullanıcı izniyle açık |

---

## 14. Ad ve ilk hazır ajan seti (öneri, K1–K2)

Ayrıntı ve çakışma taraması: `scratch/2026-10-31-rakip-analizi/braavolabs/ONERI-AD-VE-AJANLAR.tr.md`. Kurucu tanımı (K7): hazır ajan = belirli alanda tanımlı görevleri olan ajan şablonu.

- **Ad önerisi:** "Kadro" (14 dilde nötr ya da olumlu; "cadre/kadra/Kader" kavramı birçok dilde ekip anlamında). Alternatifler: tanımlayıcı "Şirket/Company", Ekip, Bureau, Atelier.
- **İlk set (CEO dahil 7):** Genel Müdür (kök) → Pazar Analisti ⭐ (rakip izleme, 6 saatte bir, modelsiz preflight), İçerik ve Sosyal Medya Sorumlusu (→ Müşteri Sesi Analisti), Finans Takipçisi (para hareketi yok), Teknik Lider (→ Sürüm ve Bağımlılık Takipçisi). Her şablon: alan, görev, periyot, araçlar, model/efor, yönetici. Şablonlar §4.1 `agent` + §4.4 `routine` kayıtlarına açılır.

---

## 13. Mevcut koddan eşleme

| Tasarım parçası | Mevcut kaynak (platform `300e17d`, desktop `f7a8879`, CLI `0fd8f4a`) | İş |
|---|---|---|
| Ajan döngüsü | `packages/api/src/modules/agent/claude.ts` (`runProviderAgentLoop`), `registry.ts`, `tool-executor.ts` | Prisma/Redis bağımlılığını depolama arayüzüne ayır, ortak pakete taşı |
| Sağlayıcılar | `packages/api/src/services/ai-client.ts`, `provider-chain.ts`, `reasoning-effort.ts` | Ortak pakete; akış desteği; efor eşlemesi (PLAN 0.4) |
| Şirket modeli | `packages/db/prisma/schema.prisma` (`Company`, `Agent`, `Pipeline`, `Run`, `RunStep`, `ToolCall`, `Approval`, `SteeringMessage`) | SQLite şeması (§4) + platform migration önerisi |
| Hiyerarşi | `modules/pipeline/hierarchical.ts`, `hierarchical-runner.ts` | `delegate` aracını org ağacına bağla |
| Zamanlayıcı | `modules/pipeline/runner.ts` (BullMQ) | Yerelde yeni modül (§6.3) |
| Onay/steering | `modules/approval/*`, `run/router.ts` `POST /runs/:id/steer` | Aynı semantik, yerel uç |
| Relay | `modules/relay/{protocol,relay.core,bus,router}.ts`; desktop `src/relay-*.ts`; CLI `src/forge/relay-*.ts` | Protokolü ortak pakete; oturum kaydını kalıcı depoya (PLAN 1.6) |
| Sandbox/guard | desktop `src-tauri/src/sandbox.rs`, `src/governance.ts`, `action_scope.rs` | Daemon yardımcı ikili olarak çağırır |
| SSRF | `packages/api/src/lib/ssrf.ts` | Ortak pakete |
| Redaction | relay `redact()` | Ortak pakete; rutin teslimi |
| MCP | desktop `src/mcp.ts`, CLI `src/forge/mcp.ts` (stdio), platform `lib/mcp.ts` (HTTP) | Daemon'da tek istemci; MCP sunucusu yeni (PLAN 5.2) |
| Bellek | `packages/memory/*`, `modules/memory/consolidation-cron.ts` | Desen alınır, yerel uygulama yeni (§7) |
| Push | `services/push.ts` | Relay üzerinden kullanılır |
| Yerel sağlayıcı | CLI `src/forge/local.ts`, `direct.ts`; desktop `src/local.ts`, `direct.ts` | Ortak pakete taşınınca kaldırılır |
