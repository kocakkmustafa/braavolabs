# AI Company OS - Kapsamli Rekabet Analizi

**Tarih:** Nisan 2026
**Not:** Bu analiz, Mayis 2025'e kadar olan veriler ve bilinen pazar dinamiklerine dayanmaktadir. Fiyatlandirma ve ozellikler degismis olabilir.

---

## ICINDEKILER

1. [Yonetici Ozeti](#1-yonetici-ozeti)
2. [Dogrudan Rakipler — AI Agent/Sirket Olusturma Platformlari](#2-dogrudan-rakipler)
3. [Komsu Rakipler — AI Workflow/Otomasyon](#3-komsu-rakipler)
4. [AI Is Araclari](#4-ai-is-araclari)
5. [Karsilastirma Matrisi](#5-karsilastirma-matrisi)
6. [AI Company OS'un Benzersiz Avantajlari](#6-benzersiz-avantajlar)
7. [Eklenmesi Gereken Ozellikler](#7-eklenmesi-gereken-ozellikler)
8. [Pazar Konumlandirma Onerisi](#8-pazar-konumlandirma)

---

## 1. Yonetici Ozeti

AI Company OS, "serbest metinle AI sirketi kur ve calistir" vaadini sunan, 9 primitive (acquisition, sales, delivery, content, operations, finance, analytics, memory, governance) uzerine kurulu, tam audit log ve memory engine'e sahip bir platformdur.

Pazar uclu katmandan olusuyor:
- **Dogrudan rakipler:** CrewAI, AutoGen, Relevance AI, Lindy AI gibi agent builder'lar — bunlar genellikle "agent olustur" odakli olup "sirket kur ve calistir" abstraction seviyesine ulasamiyor.
- **Komsu rakipler:** n8n, Make, Zapier gibi otomasyon araclari — guclu workflow engine'lere sahip ama AI-native degil, "sirket" kavrami yok.
- **AI is araclari:** Jasper, Copy.ai, Clay, 11x gibi dikey cozumler — tek bir fonksiyona (icerik, satis, veri) odakli, butunlesik platform degil.

**AI Company OS'un en buyuk farki:** Hicbir rakip "serbest metinle tam bir sirket kur + 9 fonksiyonel alan + memory engine + audit trail + marketplace + self-hosted" kombinasyonunu sunmuyor.

---

## 2. Dogrudan Rakipler — AI Agent/Sirket Olusturma Platformlari

### 2.1 CrewAI / CrewAI Enterprise

**Ne yapar:** Python-tabanli multi-agent orchestration framework. Agent'lara rol, hedef ve backstory vererek takim olarak calistirir. Enterprise versiyonu hosted cozum sunar.

**Fiyatlandirma:**
- Open-source framework: Ucretsiz
- CrewAI Enterprise: Ozel fiyatlandirma (tahmini $500-2000+/ay)
- CrewAI+: ~$200/ay (hosted cozum)

**Temel Ozellikler:**
- Role-based agent tanimlama (role, goal, backstory)
- Sequential ve hierarchical task execution
- Tool entegrasyonu (LangChain tools, custom tools)
- Memory sistemi (short-term, long-term, entity memory)
- Process tipi secimi (sequential, hierarchical, consensual)
- Enterprise: GUI, monitoring, deployment

**CrewAI'de olup AI Company OS'ta olmayan:**
- Python ekosistemi genisligi (LangChain tools ile entegrasyon)
- Daha buyuk acik kaynak topluluk (60k+ GitHub star)
- Hierarchical ve consensual process tipleri
- Agent-to-agent delegation (bir agent digerine is verebilir)
- Daha fazla LLM provider destegi (yerel modeller dahil)

**AI Company OS'ta olup CrewAI'de olmayan:**
- "Sirket" seviyesinde abstraction (CrewAI sadece "crew/takim")
- 9 Primitive sistemi — is fonksiyonlari hazir modeller
- Serbest metin ile sirket olusturma + clarification loop
- HubSpot CRM entegrasyonu (native)
- Stripe billing + usage metering (native)
- Full audit log + reasoning zorunlulugu
- Blueprint marketplace
- Governance + risk stops (spam, loop, cost anomaly)
- Self-hosted Docker Compose deployment
- Onay mekanizmasi (spend approval)
- Memory lifecycle (candidate -> approved -> deprecated)
- Export sistemi

**Zayif yonleri:**
- Sadece developer'lara yonelik (no-code yok)
- "Sirket calistirma" kavrami yok, sadece "gorev calistir"
- Uzun sureli (7/24) calisma icin tasarlanmamis
- Native CRM/billing yok
- Enterprise versiyonun fiyati belirsiz

---

### 2.2 AutoGen (Microsoft)

**Ne yapar:** Microsoft'un multi-agent conversation framework'u. Agent'lar birbirleriyle konusarak problemleri cozer. AG2 (AutoGen 2.0) ile buyuk yeniden yapilandirma gecirdi.

**Fiyatlandirma:** Tamamen ucretsiz, acik kaynak (MIT lisansi)

**Temel Ozellikler:**
- Multi-agent konversasyon patterni
- Human-in-the-loop destegi
- Code execution (Docker sandbox)
- Coklu LLM destegi (Azure OpenAI, OpenAI, yerel modeller)
- GroupChat — birden fazla agent tartismasi
- AutoGen Studio — GUI ile agent olusturma
- Teachable agents — kullanicidan ogrenen agent'lar

**AutoGen'de olup AI Company OS'ta olmayan:**
- Code execution sandbox (Docker icinde guvenli kod calistirma)
- Agent-to-agent konversasyon patterni
- AutoGen Studio GUI (drag-and-drop agent tasarimi)
- Microsoft ekosistemi entegrasyonu (Azure, M365)
- Teachable agents kavrami
- Daha buyuk akademik ve kurumsal topluluk

**AI Company OS'ta olup AutoGen'de olmayan:**
- Production-ready "sirket" kavrami
- 9 Primitive ile is fonksiyonu modelleme
- CRM, billing, outreach — hazir is entegrasyonlari
- Audit log + zorunlu reasoning
- Memory lifecycle yonetimi
- Blueprint marketplace
- Governance + risk stops
- Self-hosted deployment (tek komutla)
- Free plan ile gercek deger sunma
- Web dashboard (Next.js)

**Zayif yonleri:**
- Tamamen developer odakli (no-code yok)
- Production deployment icin ek altyapi gerekli
- Is sureclerine yonelik hazir sablonlar yok
- Karmasik API, ogrenme egrisi yuksek
- Uzun sureli 7/24 calisma icin tasarlanmamis
- AG2 gecisi ekosistemde kafa karisikligi yaratti

---

### 2.3 AgentGPT / Reworkd

**Ne yapar:** Tarayici tabanli otonom AI agent. Kullanici bir hedef verir, agent alt gorevlere bolup calisir. Reworkd sirketinin urunu.

**Fiyatlandirma:**
- Ucretsiz demo (sinirli)
- Pro: ~$40/ay
- Enterprise: Ozel fiyatlandirma

**Temel Ozellikler:**
- Hedef-tabanli otonom calisma
- Alt gorev olusturma ve yurutme
- Web arama ve bilgi toplama
- Tarayici tabanli (kurulum yok)
- Basit ve hizli baslangic

**AgentGPT'de olup AI Company OS'ta olmayan:**
- Sifir kurulum, aninda baslama (tarayici icinde)
- Cok daha basit kullanici deneyimi
- Dusuk fiyat noktasi ($40/ay)

**AI Company OS'ta olup AgentGPT'de olmayan:**
- Coklu agent orchestration (AgentGPT tek agent)
- 9 Primitive ile yapilandirilmis is surecleri
- Memory engine (AgentGPT session-based, kalici degil)
- CRM, billing, outreach entegrasyonu
- Audit log + governance
- Marketplace/blueprint
- Self-hosted deployment
- Pipeline ve workflow yonetimi
- 7/24 surekli calisma

**Zayif yonleri:**
- Cok sinirli yetenek (tek agent, sinirli tool)
- Kalici bellek yok
- Is sureclerine yonelik degil
- Gercek entegrasyonlar cok az
- Uzun gorevlerde basarisiz (hallucination, loop)
- Proje aktif gelistirme durmus gorunuyor

---

### 2.4 Relevance AI

**Ne yapar:** No-code AI agent ve workflow builder. Kullanicilar AI agent'lar olusturup tool'larla donatiyor, sonra bunlari ekip olarak calistiriyor.

**Fiyatlandirma:**
- Free: 100 credit/ay
- Pro: $99/ay (10,000 credit)
- Business: $499/ay
- Enterprise: Ozel

**Temel Ozellikler:**
- No-code agent builder
- Tool library (100+ hazir tool)
- Multi-step agent workflows
- Agent "Workforce" kavrami — agent takimlari
- CRM entegrasyonu (Salesforce, HubSpot)
- Coklu LLM destegi
- Bilgi tabani (knowledge base) yukleme
- Human-in-the-loop onay mekanizmasi
- API erisimleri

**Relevance AI'da olup AI Company OS'ta olmayan:**
- No-code visual agent builder (drag-and-drop)
- 100+ hazir tool kutuphanesi
- Salesforce entegrasyonu
- Daha genis bilgi tabani destegi (PDF, web, DB)
- "Workforce" agent takim yonetimi GUI'si
- Daha olgun no-code deneyimi

**AI Company OS'ta olup Relevance AI'da olmayan:**
- "Sirket" seviyesinde abstraction
- 9 Primitive ile yapilandirilmis is fonksiyonlari
- Serbest metinle sirket olusturma
- Full audit log + zorunlu reasoning aciklamasi
- Memory lifecycle (candidate -> approved -> deprecated)
- Holding brain kavrami (sirkeler arasi ogrenme)
- Blueprint marketplace
- Governance + risk stops (spam, loop, cost anomaly)
- Self-hosted deployment
- Stripe native billing
- Export sistemi

**Zayif yonleri:**
- Credit sistemi pahali olabilir (karmasik agent'lar hizla credit tuketir)
- "Sirket yonetimi" degil "agent yonetimi" odakli
- Audit trail sinirli
- Self-hosted yok
- Memory sistemi basit (lifecycle yok)

---

### 2.5 Lindy AI

**Ne yapar:** "AI asistan ordusu" platformu. Kullanicilar farkli isler icin AI asistanlari olusturup calistirir. Ozellikle e-posta, takvim, CRM otomasyonu icin guclu.

**Fiyatlandirma:**
- Free: 400 credit/ay
- Pro: $49.99/ay (5,000 credit)
- Business: $199.99/ay
- Enterprise: Ozel

**Temel Ozellikler:**
- 3000+ hazir "Lindy" sablonu
- E-posta otomasyonu (Gmail, Outlook)
- Takvim yonetimi
- CRM otomasyonu
- Meeting asistani (transkripsiyon, ozet)
- Trigger-tabanli calisma (e-posta gelince, takvim olayi, vb.)
- Coklu LLM destegi
- Zapier/Make entegrasyonu
- "Society of Lindies" — agent'lar arasi iletisim

**Lindy AI'da olup AI Company OS'ta olmayan:**
- 3000+ hazir sablon
- Native e-posta/takvim entegrasyonu
- Meeting asistani (transkripsiyon)
- Trigger-tabanli otomasyon (event-driven)
- Daha dusuk fiyat noktasi
- Daha olgun consumer deneyimi
- Mobil uygulama

**AI Company OS'ta olup Lindy AI'da olmayan:**
- "Sirket" seviyesinde abstraction (Lindy = asistan, Company OS = sirket)
- 9 Primitive ile yapilandirilmis is fonksiyonlari
- Full audit log + zorunlu reasoning
- Memory lifecycle + holding brain
- Governance + risk stops
- Blueprint marketplace
- Self-hosted deployment
- Pipeline orchestration
- Stripe native billing + usage metering
- Export sistemi
- Outreach sequencing (CRM-native)

**Zayif yonleri:**
- "Asistan" odakli, "sirket/isletme" degil
- Audit trail sinirli
- Karmasik is surecleri icin yeterli degil
- Self-hosted yok
- Enterprise governance zayif

---

### 2.6 Bardeen AI

**Ne yapar:** Chrome extension tabanli otomasyon araci. Web scraping, CRM gunceleme, e-posta otomasyonu gibi rutin isleri otomatiklestirir. AI ile dogal dilde otomasyon olusturma.

**Fiyatlandirma:**
- Free: Sinirli
- Professional: $10/ay (kullanici basi)
- Business: $15/ay (kullanici basi)
- Enterprise: Ozel

**Temel Ozellikler:**
- Chrome extension ile calismasi
- Web scraping + veri cikartma
- CRM otomasyonu (Salesforce, HubSpot)
- E-posta otomasyonu
- LinkedIn otomasyonu
- "Magic Box" — dogal dille otomasyon olusturma
- 100+ entegrasyon

**Bardeen'de olup AI Company OS'ta olmayan:**
- Chrome extension ile dogrudan web etkilesimi
- Web scraping yetenegi
- LinkedIn otomasyonu
- Cok dusuk fiyat ($10/ay)
- Daha basit ogrenme egrisi

**AI Company OS'ta olup Bardeen'de olmayan:**
- Multi-agent orchestration
- "Sirket" kavrami
- Memory engine
- Audit log + governance
- Pipeline yonetimi
- Blueprint marketplace
- Self-hosted deployment
- 9 Primitive sistemi
- Stripe billing

**Zayif yonleri:**
- Sadece Chrome extension (sinirli ortam)
- Karmasik is surecleri icin yetersiz
- AI karar verme kapasitesi sinirli
- Otonom calisma degil, daha cok "makro" mantigi
- Enterprise governance yok

---

### 2.7 Cassidy AI

**Ne yapar:** Kurumsal AI asistan platformu. Sirket bilgi tabanini kullanarak AI asistanlar olusturma, workflow otomasyon ve ekip genelinde AI dagitimi.

**Fiyatlandirma:**
- Starter: ~$50/kullanici/ay
- Business: Ozel
- Enterprise: Ozel

**Temel Ozellikler:**
- Kurumsal bilgi tabani entegrasyonu (Notion, Confluence, Drive)
- AI asistan olusturma (bilgi tabani bazli)
- Workflow otomasyon
- Ekip genelinde AI dagitimi
- Guvenlik ve compliance odakli
- SSO, RBAC
- 100+ entegrasyon

**Cassidy'de olup AI Company OS'ta olmayan:**
- Daha genis bilgi tabani entegrasyonu (Notion, Confluence, vb.)
- SSO (SAML/OIDC)
- Kurumsal compliance sertifikalari (SOC2)
- Ekip genelinde AI dagitimi yonetimi

**AI Company OS'ta olup Cassidy'de olmayan:**
- Otonom sirket calistirma (Cassidy = asistan, Company OS = sirket)
- 9 Primitive sistemi
- Pipeline orchestration
- Memory lifecycle + holding brain
- Blueprint marketplace
- Governance + risk stops
- Self-hosted deployment
- Export sistemi
- Outreach sequencing

**Zayif yonleri:**
- "Asistan" odakli, otonom calisma sinirli
- Fiyat yuksek (kullanici basi)
- Workflow yetenekleri sinirli
- Otonom karar verme ve calisma yok

---

### 2.8 Spell.so

**Ne yapar:** AI agent platformu. GPT-4 tabanli otonom agent'lar olusturma. Plugin destegi ile genis yetenek yelpazesi.

**Fiyatlandirma:**
- Pro: ~$9/ay (sinirli)
- Ultra: ~$29/ay

**Temel Ozellikler:**
- Otonom AI agent
- Plugin ekosistemi
- Web arama ve bilgi toplama
- Paralel agent calistirma

**Zayif yonleri:**
- Cok sinirli ozellik seti
- Kucuk ekip, yavas gelistirme
- Enterprise ozellikleri yok
- Audit, governance, memory yok
- Proje buyuk olcude durmus gorunuyor

---

## 3. Komsu Rakipler — AI Workflow/Otomasyon

### 3.1 n8n (AI Workflows)

**Ne yapar:** Acik kaynakli workflow otomasyon platformu. Son donemde AI node'lari (LLM, vector store, AI agent) eklendi. Self-hosted veya cloud.

**Fiyatlandirma:**
- Community (self-hosted): Ucretsiz
- Starter: $24/ay
- Pro: $60/ay
- Enterprise: Ozel

**Temel Ozellikler:**
- 400+ entegrasyon node'u
- Visual workflow builder (drag-and-drop)
- AI Agent node (LLM + tools + memory)
- Vector store entegrasyonu
- Self-hosted destegi
- Webhook trigger'lar
- Error handling + retry
- Community workflow sablonlari
- Sub-workflow destegi

**n8n'de olup AI Company OS'ta olmayan:**
- 400+ hazir entegrasyon
- Visual workflow builder
- Daha olgun error handling + retry mekanizmasi
- Daha buyuk topluluk ve sablon kutuphanesi
- Credential yonetimi (guvenli entegrasyon kimlik bilgileri)
- Versiyonlama (workflow versiyonlari)

**AI Company OS'ta olup n8n'de olmayan:**
- "Sirket" seviyesinde abstraction
- 9 Primitive ile is fonksiyonu modelleme
- Serbest metinle sirket olusturma
- Full audit log + zorunlu reasoning
- Memory lifecycle + holding brain
- Governance + risk stops
- Blueprint marketplace
- Native CRM + billing
- Otonom karar verme (n8n deterministik workflow)
- Export sistemi
- PQL scoring

**Zayif yonleri:**
- AI yetenekleri eklenti niteligi (core degil)
- Agent kavrami yeni ve basit
- "Is sirketi" abstraction'i yok
- Otonom karar verme yok (kullanici workflow tasarlamali)
- Memory ve ogrenme yok

**NOT:** AI Company OS zaten n8n'i V1 workflow engine olarak kullaniyor. Bu komsu rakip ayni zamanda teknoloji ortagi.

---

### 3.2 Make.com (eski Integromat)

**Ne yapar:** No-code otomasyon platformu. Visual senaryo builder ile uygulama entegrasyonlari.

**Fiyatlandirma:**
- Free: 1,000 operasyon/ay
- Core: $10.59/ay (10,000 ops)
- Pro: $18.82/ay (10,000 ops + daha fazla ozellik)
- Teams: $34.12/ay
- Enterprise: Ozel

**Temel Ozellikler:**
- 1500+ uygulama entegrasyonu
- Visual senaryo builder
- Veri donusturme ve islem modulleri
- Error handling + otomatik retry
- Webhook destegi
- Scheduling
- Son zamanlarda AI modulleri (OpenAI, vb.)
- Data stores (kalici veri)

**Make'te olup AI Company OS'ta olmayan:**
- 1500+ entegrasyon
- Cok daha olgun veri donusturme araclari
- Daha guclu hata yonetimi (auto-retry, error routes)
- Visual senaryo tasarimcisi
- Daha dusuk fiyat

**AI Company OS'ta olup Make'te olmayan:**
- AI-native platform (Make'te AI eklenti)
- Otonom karar verme
- "Sirket" kavrami
- Memory engine
- Audit log + governance
- Blueprint marketplace
- Self-hosted (Make tamamen cloud)

**Zayif yonleri:**
- AI yetenekleri sinirli (sadece API cagrilari)
- Otonom calisma yok
- Memory/ogrenme yok
- Developer deneyimi zayif (no-code only)

---

### 3.3 Zapier (AI Actions / Central)

**Ne yapar:** Dunyanin en buyuk no-code otomasyon platformu. Zapier Central ile AI agent ozellikleri ekledi.

**Fiyatlandirma:**
- Free: 100 gorev/ay
- Starter: $29.99/ay
- Professional: $73.50/ay
- Team: $103.50/ay
- Enterprise: Ozel

**Temel Ozellikler:**
- 7000+ uygulama entegrasyonu
- Zap (workflow) builder
- Zapier Central (AI agent — yeni)
- AI Actions (LLM'leri Zap icinde kullanma)
- Zapier Tables (veri depolama)
- Zapier Canvas (is sureci haritalama)
- Natural language ile Zap olusturma

**Zapier'de olup AI Company OS'ta olmayan:**
- 7000+ entegrasyon
- Cok buyuk kullanici tabani ve ekosistem
- Zapier Tables (basit veri tabani)
- Canvas (is sureci gorsellestirme)
- Daha olgun kurumsal ozellikler

**AI Company OS'ta olup Zapier'de olmayan:**
- AI-native sirket olusturma
- Otonom, surekli calisan agent'lar
- Memory engine + lifecycle
- Full audit log + zorunlu reasoning
- Governance + risk stops
- Blueprint marketplace
- Self-hosted deployment
- 9 Primitive sistemi
- CRM-native outreach

**Zayif yonleri:**
- Zapier Central cok yeni ve sinirli
- AI yetenekleri hala eklenti niteligi
- Pahali (yuksek hacimde)
- Self-hosted yok
- Otonom karar verme sinirli

---

### 3.4 Activepieces

**Ne yapar:** Acik kaynakli Zapier alternatifi. Self-hosted veya cloud. AI parcalari ekleniyor.

**Fiyatlandirma:**
- Community (self-hosted): Ucretsiz
- Pro: $10/ay
- Platform: Ozel

**Temel Ozellikler:**
- 200+ entegrasyon
- Acik kaynak (MIT)
- Self-hosted destegi
- Visual flow builder
- Webhook trigger'lar
- AI araclari (GPT, Claude entegrasyonu)

**AI Company OS'a gore durumu:**
- Basit otomasyon araci, AI-native degil
- "Sirket" kavrami yok
- Memory, audit, governance yok
- Ancak self-hosted ve acik kaynak olarak rakip

---

### 3.5 Langflow / Flowise

**Ne yapar:** LangChain/LlamaIndex tabanli visual AI workflow builder'lar. Drag-and-drop ile AI pipeline olusturma.

**Fiyatlandirma:**
- Acik kaynak: Ucretsiz
- Langflow Cloud (DataStax): Free tier + paid planlar

**Temel Ozellikler:**
- Visual AI pipeline builder
- LangChain/LlamaIndex entegrasyonu
- RAG pipeline olusturma
- Coklu LLM destegi
- Vector store entegrasyonu
- Chatbot olusturma
- API endpoint olusturma

**Bu araclarda olup AI Company OS'ta olmayan:**
- Visual AI pipeline builder (drag-and-drop)
- RAG pipeline olusturma kolayligi
- Daha genis vector store destegi
- LangChain ekosistemi erisimleri

**AI Company OS'ta olup bunlarda olmayan:**
- "Sirket" abstraction'i
- Is sureci primitive'leri
- CRM, billing, outreach
- Audit log + governance
- Memory lifecycle
- Blueprint marketplace
- Self-hosted production deployment
- 7/24 surekli calisma

**Zayif yonleri:**
- Sadece AI pipeline araciari, is sureci yonetimi yok
- Production deployment karmasik
- Izleme ve audit yok
- Memory/ogrenme yok

---

## 4. AI Is Araclari

### 4.1 Jasper AI

**Ne yapar:** AI icerik olusturma platformu. Marka sesi ile tutarli icerik uretimi. Pazarlama ekiplerine yonelik.

**Fiyatlandirma:**
- Creator: $49/ay
- Pro: $69/ay
- Business: Ozel

**Temel Ozellikler:**
- Marka sesi ve stili ogrenme
- Blog, sosyal medya, reklam icerigi
- SEO optimizasyonu
- Sablon kutuphanesi
- Ekip isbirligi
- Chrome extension
- Jasper Chat (chatbot)
- Kampanya olusturma
- Bilgi tabani entegrasyonu

**AI Company OS ile karsilastirma:**
- Jasper SADECE icerik olusturma, Company OS 9 farkli is alani
- Jasper'in icerik kalitesi muhtemelen daha yuksek (uzmanlasmis)
- Company OS daha genis kapsam ama icerik konusunda daha az derinlik

---

### 4.2 Copy.ai (GTM AI Platform)

**Ne yapar:** Baslangicta icerik olusturma araci, simdi "GTM AI Platform" olarak konumlaniyor. Sales, marketing ve operations icin AI workflow'lari.

**Fiyatlandirma:**
- Free: 2,000 kelime/ay
- Starter: $49/ay
- Advanced: $249/ay
- Enterprise: Ozel

**Temel Ozellikler:**
- AI workflow builder (Go-To-Market odakli)
- Satis e-posta olusturma
- Prospect arastirma
- Icerik olusturma (blog, sosyal medya)
- Data enrichment
- CRM entegrasyonu
- Workflow sablonlari
- Ekip isbirligi

**Copy.ai'de olup AI Company OS'ta olmayan:**
- GTM-spesifik workflow sablonlari
- Daha derinlesmis satis icerigi olusturma
- Data enrichment yetenekleri
- Prospect arastirma araclari

**AI Company OS'ta olup Copy.ai'de olmayan:**
- 9 Primitive (sadece GTM degil, tum is alanlari)
- Otonom sirket calistirma
- Memory engine + lifecycle
- Full audit log + governance
- Blueprint marketplace
- Self-hosted deployment
- Risk stops
- Pipeline orchestration

---

### 4.3 Clay

**Ne yapar:** Data enrichment + outreach platformu. 75+ veri kaynagiyla prospect bilgisi zenginlestirme, AI ile kisisellestirilmis e-posta olusturma.

**Fiyatlandirma:**
- Free: 100 credit/ay
- Starter: $149/ay
- Explorer: $349/ay
- Pro: $800/ay
- Enterprise: Ozel

**Temel Ozellikler:**
- 75+ veri enrichment kaynagi (Clearbit, Apollo, vb.)
- AI mesaj kisisellestirme
- Spreadsheet benzeri arayuz
- Waterfall enrichment (bir kaynak bos ise digerini dene)
- CRM senkronizasyonu
- Outreach entegrasyonu
- Webhook trigger'lar

**Clay'de olup AI Company OS'ta olmayan:**
- 75+ data enrichment kaynagi
- Waterfall enrichment stratejisi
- Spreadsheet arayuzu (veri manipulasyonu)
- Daha derinlesmis prospect bilgisi

**AI Company OS'ta olup Clay'de olmayan:**
- Otonom sirket calistirma (Clay sadece data + outreach)
- 9 Primitive (Clay sadece acquisition/sales)
- Memory engine
- Audit log + governance
- Blueprint marketplace
- Pipeline orchestration
- Self-hosted deployment
- Delivery, operations, finance, analytics primitive'leri

---

### 4.4 11x.ai

**Ne yapar:** "AI dijital calisanlar" platformu. Alice (SDR — satis gelistirme temsilcisi) ve Jordan (telefon agent) gibi AI calisanlar sunuyor.

**Fiyatlandirma:**
- Alice (AI SDR): ~$5,000+/ay (tahmini)
- Jordan (AI Caller): Ozel
- Enterprise: Ozel

**Temel Ozellikler:**
- Alice: Otonom SDR — prospect bulma, e-posta yazma, takip
- Jordan: AI telefon gorusmesi yapma
- Veri enrichment
- Coklu kanal outreach (e-posta, LinkedIn, telefon)
- CRM entegrasyonu
- Otonom calismasi (7/24)

**11x'te olup AI Company OS'ta olmayan:**
- AI telefon gorusmesi (voice agent)
- LinkedIn outreach otomasyonu
- Daha derinlesmis SDR workflow'u
- Daha fazla outreach kanali

**AI Company OS'ta olup 11x'te olmayan:**
- 9 Primitive (11x sadece satis)
- Sirket olusturma (11x sadece satis agent)
- Memory engine
- Audit log + governance
- Blueprint marketplace
- Self-hosted deployment
- Cok daha dusuk fiyat
- Icerik, operasyon, finans, analitik yetenekleri

**Zayif yonleri:**
- Cok pahali ($5k+/ay)
- Sadece satisa odakli
- Self-hosted yok
- Audit trail sinirli

---

### 4.5 Artisan AI

**Ne yapar:** 11x'e benzer, AI "artisan" (usta) calisanlar. Ava (satis), digerlerinin gelmesi planlaniyor. Sales agent odakli.

**Fiyatlandirma:**
- Tahmini $2,000-5,000/ay
- Ozel fiyatlandirma

**Temel Ozellikler:**
- Ava: AI satis temsilcisi
- B2B lead bulma + outreach
- E-posta kisisellestirme
- CRM entegrasyonu
- Coklu kanal

**Durumu:** 11x ile ayni kategoride, benzer guclu/zayif yonler. Pahali, sadece satisa odakli.

---

## 5. Karsilastirma Matrisi

| Ozellik | AI Company OS | CrewAI | AutoGen | Relevance AI | Lindy AI | n8n | Zapier | Copy.ai | Clay | 11x.ai |
|---------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Serbest Metinle Sirket Olusturma** | ++ | - | - | ~ | ~ | - | ~ | - | - | - |
| **9 Primitive Is Fonksiyonlari** | ++ | - | - | - | - | - | - | ~ | - | - |
| **Multi-Agent Orchestration** | + | ++ | ++ | + | + | ~ | - | - | - | ~ |
| **Memory Engine (Lifecycle)** | ++ | + | ~ | ~ | - | - | - | - | - | - |
| **Holding Brain (Sirkeler Arasi Ogrenme)** | ++ | - | - | - | - | - | - | - | - | - |
| **Full Audit Log + Reasoning** | ++ | - | - | ~ | - | - | - | - | - | - |
| **Governance + Risk Stops** | ++ | - | - | - | - | - | - | - | - | - |
| **Blueprint Marketplace** | ++ | - | - | ~ | + | + | + | ~ | - | - |
| **CRM Entegrasyonu (Native)** | + | - | - | + | + | + | ++ | + | ++ | + |
| **Stripe Billing (Native)** | ++ | - | - | - | - | - | - | - | - | - |
| **Self-Hosted Deployment** | ++ | + | ++ | - | - | ++ | - | - | - | - |
| **No-Code Arayuz** | + | - | - | ++ | ++ | + | ++ | + | + | + |
| **Visual Workflow Builder** | - | - | ~ | + | + | ++ | ++ | + | ~ | - |
| **Entegrasyon Sayisi** | ~ | ~ | ~ | + | + | ++ | ++ | + | ++ | ~ |
| **7/24 Otonom Calisma** | ++ | ~ | ~ | + | + | + | + | - | - | ++ |
| **Outreach Sequencing** | + | - | - | ~ | + | ~ | ~ | + | ++ | ++ |
| **Data Enrichment** | - | - | - | ~ | - | ~ | ~ | + | ++ | + |
| **AI Telefon (Voice)** | - | - | - | - | - | - | - | - | - | ++ |
| **Export Sistemi** | ++ | - | - | - | - | + | + | - | - | - |
| **Fiyat/Deger Orani** | ++ | + | ++ | + | ++ | ++ | + | + | ~ | - |

**Gosterge:** ++ = Cok guclu, + = Guclu, ~ = Kismi/Orta, - = Yok/Zayif

---

## 6. AI Company OS'un Benzersiz Avantajlari

### 6.1 Sirket Seviyesinde Abstraction
Hicbir rakip "sirket kur ve calistir" seviyesinde bir abstraction sunmuyor. CrewAI "crew" (takim), Relevance AI "workforce", Lindy "asistan" — hepsi daha alt seviye. AI Company OS kullaniciya "10 dakikada sirketini kur" vaadi veriyor.

### 6.2 9 Primitive Sistemi
Acquisition, sales, delivery, content, operations, finance, analytics, memory, governance — bu sekilde yapilandirilmis is fonksiyonlari hicbir rakipte yok. Rakipler ya sadece satisa (11x, Clay) ya da sadece icerge (Jasper) odakli. Company OS tum is fonksiyonlarini kapsayan tek platform.

### 6.3 Memory Lifecycle + Holding Brain
`candidate -> approved -> deprecated` memory lifecycle'i ve "2+ farkli sirkette tekrar eden basari ile holding brain'e tasima" kavrami tamamen benzersiz. CrewAI'de basit memory var ama lifecycle yok. Diger rakiplerin cogunluinda memory bile yok.

### 6.4 Full Audit Log + Zorunlu Reasoning
HER tool call, HER karar, HER aksiyonun loglanmasi ve "neden bu karari verdin?" zorunlulugu — bu seviyede transparency hicbir rakipte yok. Enterprise compliance icin kritik farklilastirici.

### 6.5 Governance + Risk Stops
`hard_stop`, `loop_stop`, `cost_anomaly_stop`, `spam_stop`, `brand_violation_stop` — bu risk mekanizmalari AI agent platformlarinda nadir. Ozellikle `spend approval` (sadece para harcayan aksiyonlarda onay) dengesi cok iyi: otonom ama kontrollü.

### 6.6 Blueprint Marketplace
Basarili sirket konfigurasyonlarini paylasma/klonlama mekanizmasi. Zapier ve n8n'de sablon paylasimi var ama "sirket blueprint'i" seviyesinde degil.

### 6.7 Self-Hosted + Cloud Hibrit
Docker Compose ile tek komutta deployment. n8n ve AutoGen da self-hosted olabilir ama "sirket OS" seviyesinde self-hosted cozum sunan baska yok.

### 6.8 Fiyat Avantaji
Free plan ile gercek deger (1 sirket, TikTok + LinkedIn, 10 run/ay). 11x $5000+/ay, Clay $800+/ay iken Company OS free tier sunuyor.

---

## 7. Eklenmesi Gereken Ozellikler (Oncelik Sirasina Gore)

### YUKSEK ONCELIK

**7.1 Visual Workflow/Pipeline Builder**
- **Neden:** Relevance AI, n8n, Make, Zapier — hepsinde visual builder var. Kullanicilar pipeline'lari gorebilmeli ve duzenleyebilmeli.
- **Oneri:** React Flow veya Xyflow kullanarak pipeline gorsellestiricisi ekle. Sadece goruntuleme ile baslayip sonra duzenleme eklenebilir.

**7.2 Daha Fazla Entegrasyon**
- **Neden:** Zapier 7000+, Make 1500+, n8n 400+ entegrasyon sunuyor. Company OS sinirli.
- **Oneri:** Entegrasyon adapter sistemi genisletilmeli. Oncelik: Slack, Google Workspace (Gmail, Calendar, Drive), Notion, Salesforce, LinkedIn API.

**7.3 Data Enrichment Modulu**
- **Neden:** Clay'in ana degeri data enrichment. Sales primitive'i icin prospect verisi zenginlestirme kritik.
- **Oneri:** Apollo.io, Clearbit, Hunter.io API entegrasyonlari ekle. Waterfall enrichment stratejisi uygula.

**7.4 Trigger/Event-Driven Calisma**
- **Neden:** Lindy, Zapier, n8n hepsi event-driven. "E-posta gelince", "CRM'de deal degisince" gibi trigger'lar gerekli.
- **Oneri:** BullMQ ile webhook listener + event bus mekanizmasi guclendir. Kullanici tanimli trigger'lar ekle.

### ORTA ONCELIK

**7.5 AI Voice/Telefon Agent**
- **Neden:** 11x.ai ve Bland AI ile telefon agent pazari buyuyor.
- **Oneri:** V2+ icin Twilio/Vapi entegrasyonu planlayabilir. Baslangiçta sadece satis alaninda.

**7.6 LinkedIn Otomasyon**
- **Neden:** Bardeen, Clay, 11x hepsinde LinkedIn destegi var. B2B satisda LinkedIn kritik kanal.
- **Oneri:** LinkedIn API (veya Phantombuster entegrasyonu) ile bağlanti istegi, mesaj gonderme.

**7.7 RAG/Knowledge Base Gelistirme**
- **Neden:** Relevance AI, Cassidy, Lindy hepsinde dokuman yukleme ve RAG var.
- **Oneri:** pgvector zaten var, PDF/web/Notion ice aktarma pipeline'i ekle. Sirket bazli bilgi tabani.

**7.8 Daha Fazla LLM Provider Destegi**
- **Neden:** CLAUDE.md'de "Claude (Anthropic API)" yaziyor. Rakipler coklu LLM destekliyor.
- **Oneri:** OpenAI, Google Gemini, Mistral, Groq adapter'lari ekle. Kullaniciya model secimi birak.

### DUSUK ONCELIK (V2+ Icin)

**7.9 Mobil Uygulama**
- **Neden:** Lindy'de mobil var. Sirket sahibinin hareket halinde izleme yapmasi onemli.
- **Oneri:** PWA ile baslayip sonra native (React Native veya Flutter) dusunulebilir.

**7.10 Agent-to-Agent Konversasyon**
- **Neden:** CrewAI ve AutoGen'in guclu yonu. Agent'lar birbirleriyle tartisarak daha iyi sonuclara ulasabilir.
- **Oneri:** Pipeline icinde agent hop noktalarinda konversasyon mekanizmasi.

**7.11 Compliance Sertifikalari (SOC2, GDPR)**
- **Neden:** Enterprise musteriler icin gerekli. Cassidy bununla one cikiyor.
- **Oneri:** Full audit log zaten var — SOC2 icin eksik parcalari tamamla.

---

## 8. Pazar Konumlandirma Onerisi

### 8.1 Pozisyon: "AI Company Builder" — Yeni Bir Kategori

Mevcut kategoriler:
- "AI Agent Builder" (CrewAI, Relevance AI)
- "AI Automation" (Zapier, Make, n8n)
- "AI Sales Tool" (11x, Clay, Copy.ai)
- "AI Content Tool" (Jasper)

AI Company OS bunlarin HICBIRINE tam olarak uymuyor. Yeni bir kategori olusturulmali:

**"AI Company Builder"** — Serbest metinle tam fonksiyonlu AI sirketi olusturan, yoneten ve olceklendiren platform.

### 8.2 Hedef Kitle Segmentasyonu

| Segment | Profil | Mesaj |
|---------|--------|-------|
| **Solo Girisimciler** | Tek basina is kurmak isteyen, teknik olmayan | "10 dakikada AI sirketini kur, 7/24 calistir" |
| **Kucuk Ekipler (2-10)** | Satis/pazarlama otomasyonu isteyen startup'lar | "5 kisinin isini 50 AI agent'a devret" |
| **Ajanlar/Danismanlar** | Musterilerine hizmet olusturan | "Her musteriniz icin ozel AI sirketi kur, blueprint'le cogalt" |
| **SMB'ler** | Operasyonel verimlilik arayan | "Tum is sureclerini tek platformda otomatiklestir" |

### 8.3 Rekabetci Konumlandirma Mesajlari

**vs. CrewAI/AutoGen:**
"CrewAI ile Python kodu yazarak agent olusturursun. AI Company OS ile Turkce/Ingilizce serbest metin yazarak sirket kurarsın — kodlama yok."

**vs. Zapier/Make/n8n:**
"Zapier her entegrasyonu elle baglaman gerekir. AI Company OS'ta 'sosyal medya ajansi kur' diyorsun, sistem 9 fonksiyonel alani otomatik yapilandiriyor."

**vs. 11x/Clay:**
"11x sadece satis icin $5000+/ay. AI Company OS'ta satis dahil 9 is fonksiyonu, free tier ile baslayip buyuyorsun."

**vs. Jasper/Copy.ai:**
"Jasper sadece icerik uretir. AI Company OS icerik uretir, dagitir, analiz eder, musteriye ulaşır, CRM'i gunceller — hepsini otonom yapar."

### 8.4 Go-To-Market Stratejisi Onerisi

1. **Free Tier ile Viral Buyume:** Hero company (Social Media Management) ile kullanicilar gercek deger gorur. TikTok + LinkedIn icerik uretimi dogal viral etki yaratir.

2. **Blueprint Marketplace ile Network Effect:** Basarili sirket blueprint'leri paylasilir, yeni kullanicilar "hazir sirket kur" yapabilir. Bu Shopify'in tema marketplace'i etkisine benzer.

3. **Self-Hosted ile Enterprise Giris:** On-prem ihtiyaci olan enterprise'lara Docker Compose deployment ile ulasilabilir. Audit log + governance zaten hazir.

4. **Content Marketing:** "AI Company OS ile kurulan sirketlerin basari hikayeleri" icerikleri uretilmeli. Gercek metrikler (kac icerik uretildi, kac lead, kac saat tasarruf) paylasılmalı.

5. **Ajans/Danışman Programi:** Blueprint marketplace ile "AI Company as a Service" sunan ajanslara ozel program. Ajanslar musterileri icin sirket kurar, Company OS altyapiyi saglar.

### 8.5 Fiyatlandirma Karsilastirmasi ve Onerisi

| Platform | Baslangic Fiyati | Enterprise |
|----------|------------------|------------|
| AI Company OS | FREE (1 sirket, 10 run) | ? |
| CrewAI+ | ~$200/ay | Ozel |
| Relevance AI | $99/ay | Ozel |
| Lindy AI | $49.99/ay | Ozel |
| n8n | $24/ay | Ozel |
| Zapier | $29.99/ay | Ozel |
| Make | $10.59/ay | Ozel |
| Copy.ai | $49/ay | Ozel |
| Clay | $149/ay | Ozel |
| 11x.ai | ~$5,000+/ay | Ozel |

**Onerilen fiyatlandirma kademe:**

| Plan | Fiyat | Icerik |
|------|-------|--------|
| **Free** | $0 | 1 sirket, 10 run/ay, TikTok + LinkedIn |
| **Starter** | $49/ay | 3 sirket, 100 run/ay, tum kanallar |
| **Pro** | $149/ay | 10 sirket, 500 run/ay, oncelikli LLM, gelismis analitik |
| **Business** | $499/ay | Sinirsiz sirket, 2000 run/ay, API, SSO |
| **Enterprise** | Ozel | Self-hosted, SLA, dedicated support, custom integration |

---

## SONUC

AI Company OS, pazardaki hicbir rakibin tam olarak sunmadigi bir deger onerisi tasiyor: **serbest metinle tam fonksiyonlu AI sirketi olusturma ve calistirma.** En buyuk rakipler ya alt seviyede (agent builder'lar), ya dar kapsamli (sadece satis/icerik), ya da AI-native olmayan otomasyon araclari.

**En kritik 3 aksiyon:**
1. Visual workflow builder ekleyerek no-code deneyimi guclendirmek (Relevance AI, n8n avantajini kapatmak)
2. Entegrasyon sayisini artirmak (en azindan top-20 SaaS araci)
3. Data enrichment modulu ekleyerek satis primitive'ini guclendirmek (Clay avantajini yakalamak)

Bu uc aksiyon tamamlandiginda, AI Company OS pazardaki en kapsamli "AI Company Builder" platformu olacaktir.
