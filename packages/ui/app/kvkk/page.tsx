"use client";

export default function KvkkPage() {
  return (
    <div className="min-h-screen" style={{ background: "#0a0d14" }}>
      <nav
        className="flex items-center justify-between px-6 md:px-10 py-5 max-w-[1100px] mx-auto"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
      >
        <a href="/" className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
          >
            <span className="text-white font-bold text-xs">AI</span>
          </div>
          <span className="font-headline font-bold text-sm" style={{ color: "#e1e2eb" }}>Braavolabs</span>
        </a>
        <a href="/" className="text-sm hover:text-white transition-colors" style={{ color: "#859399" }}>← Geri</a>
      </nav>

      <div className="max-w-[720px] mx-auto px-6 py-16">
        <div className="mb-10">
          <h1 className="font-headline font-extrabold mb-2" style={{ fontSize: "2rem", color: "#e1e2eb" }}>KVKK Aydınlatma Metni</h1>
          <p className="text-sm" style={{ color: "#3c494e" }}>Son güncelleme: Mayıs 2026</p>
        </div>

        <div className="space-y-8 text-sm leading-relaxed" style={{ color: "#859399" }}>
          {[
            { title: "Veri Sorumlusu", body: "Braavolabs (\"Şirket\"), 6698 sayılı Kişisel Verilerin Korunması Kanunu (\"KVKK\") kapsamında veri sorumlusu sıfatıyla hareket eder. İletişim: kvkk@braavolabs.com." },
            { title: "İşlenen Kişisel Veriler", body: "Kimlik (ad, soyad), iletişim (e-posta, organizasyon adı), müşteri işlem (abonelik durumu, fatura geçmişi), müşteri davranış (pipeline çalıştırma kayıtları, kullanım metrikleri), log (IP, oturum kimliği, denetim izleri). Ödeme bilgileri Stripe üzerinden işlenir; kart numaranızı tarafımızda saklamayız." },
            { title: "İşleme Amaçları", body: "Sözleşmesel yükümlülüklerin yerine getirilmesi (hizmet sunumu, fatura), müşteri desteği, ürün iyileştirme, güvenlik ve dolandırıcılık önleme, yasal yükümlülükler (TTK, vergi mevzuatı) ve onayınız varsa pazarlama iletişimi." },
            { title: "Hukuki Sebepler", body: "KVKK madde 5/2-c (sözleşmenin kurulması/ifası), 5/2-ç (hukuki yükümlülük), 5/2-f (meşru menfaat) ve pazarlama iletişimi için 5/1 kapsamında açık rıza." },
            { title: "Üçüncü Taraf Aktarımları", body: "Hizmet sağlayıcılarımız: Stripe (ödeme, ABD), SendGrid (e-posta, ABD), HubSpot (CRM, ABD — opsiyonel), Google OAuth (kimlik doğrulama, ABD — opsiyonel), GitHub OAuth (kimlik doğrulama, ABD — opsiyonel), AWS Lightsail (barındırma, AB Frankfurt). Yurt dışı aktarımlar KVKK madde 9 kapsamında standart sözleşme hükümleri ile yapılır." },
            { title: "Saklama Süresi", body: "Hesabınız aktif olduğu sürece verileriniz işlenir. Hesap kapatıldıktan sonra TTK gereği 10 yıl boyunca finansal kayıtlar saklanır. Pazarlama amaçlı veriler rıza geri çekilince derhal silinir." },
            { title: "Haklarınız (KVKK Madde 11)", body: "Kişisel verilerinizin işlenip işlenmediğini öğrenme; işlenmişse bilgi talep etme; işlenme amacını ve amacına uygun kullanılıp kullanılmadığını öğrenme; yurt içinde/yurt dışında aktarıldığı tarafları bilme; eksik/yanlış işlenmişse düzeltilmesini isteme; silinmesini/yok edilmesini isteme; düzeltme/silme/yok etme işlemlerinin aktarılan taraflara bildirilmesini isteme; otomatik sistemlerle analiz edilerek aleyhinize sonuç çıkmasına itiraz etme; hukuka aykırı işleme nedeniyle zarara uğradıysanız tazminat talep etme haklarına sahipsiniz." },
            { title: "Başvuru", body: "Haklarınızı kullanmak için kvkk@braavolabs.com adresine yazılı başvuruda bulunabilirsiniz. Başvurunuza KVKK madde 13 uyarınca en geç 30 gün içinde ücretsiz olarak yanıt veririz." },
          ].map((section) => (
            <div key={section.title}>
              <h2 className="font-headline font-semibold text-sm mb-2" style={{ color: "#e1e2eb" }}>{section.title}</h2>
              <p>{section.body}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
