import anthropic
import requests
import os
import json
from datetime import datetime, timedelta

client = anthropic.Anthropic(api_key=os.environ['ANTHROPIC_API_KEY'])

SITE_URL = 'https://doctor-pdf.com/'

# ── 1. CHECK OUR SITE ──
def check_site():
    tools = [
        'compress-pdf','stamp-pdf','rotate-pdf','merge-pdf',
        'split-pdf','sign-pdf','protect-pdf','watermark-pdf',
        'image-to-pdf','pdf-to-image','extract-text',
        'convert-image','remove-background','ocr'
    ]
    working, broken = [], []
    for tool in tools:
        try:
            r = requests.get(f'https://doctor-pdf.com/{tool}.html', timeout=10)
            if r.status_code == 200:
                working.append(tool)
            else:
                broken.append(f'{tool} (HTTP {r.status_code})')
        except Exception as e:
            broken.append(f'{tool} (Error: {str(e)[:30]})')
    return {
        'working': working, 'broken': broken,
        'total': len(tools),
        'uptime_pct': round(len(working) / len(tools) * 100, 1)
    }

# ── 2. GOOGLE SEARCH CONSOLE — REAL VISITOR DATA ──
COUNTRY_AR = {
    'egy': 'مصر', 'sau': 'السعودية', 'are': 'الإمارات', 'mar': 'المغرب',
    'dza': 'الجزائر', 'irq': 'العراق', 'jor': 'الأردن', 'kwt': 'الكويت',
    'qat': 'قطر', 'omn': 'عُمان', 'bhr': 'البحرين', 'yem': 'اليمن',
    'lby': 'ليبيا', 'tun': 'تونس', 'syr': 'سوريا', 'lbn': 'لبنان',
    'pse': 'فلسطين', 'sdn': 'السودان', 'usa': 'أمريكا', 'gbr': 'بريطانيا',
    'deu': 'ألمانيا', 'fra': 'فرنسا', 'ind': 'الهند', 'pak': 'باكستان',
}

def _d(n):
    return (datetime.now() - timedelta(days=n)).strftime('%Y-%m-%d')

def _gsc_query(service, start, end, dimensions, row_limit=25, filters=None):
    body = {'startDate': start, 'endDate': end,
            'dimensions': dimensions, 'rowLimit': row_limit}
    if filters:
        body['dimensionFilterGroups'] = filters
    return service.searchanalytics().query(siteUrl=SITE_URL, body=body).execute().get('rows', [])

def fetch_gsc_data():
    """Read real Search Console data via a service-account key (env GSC_CREDENTIALS).
    Returns a markdown text block, or None if not configured / on error."""
    creds_json = os.environ.get('GSC_CREDENTIALS', '').strip()
    if not creds_json:
        print("ℹ️ GSC_CREDENTIALS not set — skipping Search Console section")
        return None
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        info = json.loads(creds_json)
        creds = service_account.Credentials.from_service_account_info(
            info, scopes=['https://www.googleapis.com/auth/webmasters.readonly'])
        service = build('searchconsole', 'v1', credentials=creds, cache_discovery=False)

        end28, start28 = _d(2), _d(30)
        # 1) Top queries (28 days)
        top_q = _gsc_query(service, start28, end28, ['query'], 25)
        top_q.sort(key=lambda r: r.get('clicks', 0), reverse=True)
        # 2) Top pages
        top_p = _gsc_query(service, start28, end28, ['page'], 15)
        top_p.sort(key=lambda r: r.get('clicks', 0), reverse=True)
        # 3) Countries
        countries = _gsc_query(service, start28, end28, ['country'], 12)
        countries.sort(key=lambda r: r.get('clicks', 0), reverse=True)
        # 4) Devices
        devices = _gsc_query(service, start28, end28, ['device'], 5)
        devices.sort(key=lambda r: r.get('clicks', 0), reverse=True)
        # 5) Opportunities: position 5-20, sorted by impressions
        opp = [r for r in top_q + _gsc_query(service, start28, end28, ['query'], 200)
               if 5 <= r.get('position', 0) <= 20]
        seen = set(); opp_u = []
        for r in opp:
            k = r['keys'][0]
            if k in seen: continue
            seen.add(k); opp_u.append(r)
        opp_u.sort(key=lambda r: r.get('impressions', 0), reverse=True)
        # 6) Trend last 7 vs prev 7
        cur = _gsc_query(service, _d(9), _d(2), ['date'], 10)
        prev = _gsc_query(service, _d(16), _d(9), ['date'], 10)
        cur_clicks = sum(r.get('clicks', 0) for r in cur)
        prev_clicks = sum(r.get('clicks', 0) for r in prev)
        cur_impr = sum(r.get('impressions', 0) for r in cur)
        prev_impr = sum(r.get('impressions', 0) for r in prev)

        if not top_q and cur_clicks == 0 and cur_impr == 0:
            return ("## 📈 بيانات Search Console\n\n"
                    "لا توجد بيانات بحث كافية بعد (الموقع جديد على الفهرسة). "
                    "ستظهر الكلمات والزيارات هنا تلقائياً بمجرد أن يبدأ الزوار في الوصول من Google.\n")

        def pct(cur_v, prev_v):
            if prev_v == 0:
                return "🆕 جديد" if cur_v > 0 else "—"
            d = round((cur_v - prev_v) / prev_v * 100)
            return f"{'🔺' if d >= 0 else '🔻'} {d:+}%"

        out = ["## 📈 زوّارك الحقيقيون (من Google Search Console — آخر 28 يوم)\n"]
        out.append(f"**الاتجاه (آخر 7 أيام مقابل السابقة):** "
                   f"النقرات {cur_clicks} ({pct(cur_clicks, prev_clicks)}) | "
                   f"الظهور {cur_impr} ({pct(cur_impr, prev_impr)})\n")

        out.append("\n### 🔝 أهم الكلمات التي جلبت زيارات")
        if top_q:
            out.append("| الكلمة | نقرات | ظهور | متوسط الترتيب |")
            out.append("|--------|-------|------|----------------|")
            for r in top_q[:12]:
                out.append(f"| {r['keys'][0]} | {int(r.get('clicks',0))} | "
                           f"{int(r.get('impressions',0))} | {r.get('position',0):.1f} |")
        else:
            out.append("لا توجد نقرات بعد.")

        out.append("\n### 🎯 فرص ذهبية (أنت في المركز 5–20 — تحسين بسيط = صفحة أولى)")
        if opp_u:
            out.append("| الكلمة | الترتيب | ظهور | نقرات |")
            out.append("|--------|---------|------|-------|")
            for r in opp_u[:10]:
                out.append(f"| {r['keys'][0]} | {r.get('position',0):.1f} | "
                           f"{int(r.get('impressions',0))} | {int(r.get('clicks',0))} |")
        else:
            out.append("لا توجد فرص في هذا النطاق بعد.")

        out.append("\n### 📄 أهم الصفحات")
        if top_p:
            out.append("| الصفحة | نقرات | ظهور |")
            out.append("|--------|-------|------|")
            for r in top_p[:10]:
                pg = r['keys'][0].replace('https://doctor-pdf.com', '')
                out.append(f"| {pg} | {int(r.get('clicks',0))} | {int(r.get('impressions',0))} |")

        out.append("\n### 🌍 الزوار من أين")
        if countries:
            parts = []
            for r in countries[:8]:
                c = r['keys'][0]
                parts.append(f"{COUNTRY_AR.get(c, c.upper())}: {int(r.get('clicks',0))}")
            out.append(" · ".join(parts))
        if devices:
            dparts = [f"{r['keys'][0]}: {int(r.get('clicks',0))}" for r in devices]
            out.append("\n**الأجهزة:** " + " · ".join(dparts))

        print("✅ Search Console data fetched")
        return "\n".join(out) + "\n"
    except Exception as e:
        print(f"⚠️ GSC fetch failed: {str(e)[:200]}")
        return None

# ── 3. DEEP COMPETITOR ANALYSIS via Claude + Web Search ──
def analyze_competitors():
    """Use Claude with web_search to analyze competitors + tool-gap + traffic strategy."""

    competitors = ['ilovepdf.com', 'smallpdf.com', 'pdf24.org', 'sejda.com']
    my_tools = ('دمج، تقسيم، ضغط، تدوير، توقيع، حماية بكلمة مرور، علامة مائية، ختم، '
                'صورة→PDF، PDF→صورة، استخراج نص، تحويل صيغ الصور، إزالة خلفية، OCR')

    search_prompt = f"""أنت محلل استراتيجي متخصص في مواقع أدوات PDF. حلّل المنافسين ({', '.join(competitors)}) لصالح موقع Doctor PDF.

أدوات Doctor PDF الحالية: {my_tools}

ابحث على الإنترنت وقدّم تحليلاً دقيقاً مقسّماً للأقسام التالية بالضبط:

## 🆚 مميزات المنافسين
ما أبرز المميزات والأدوات القوية عند كل منافس؟ وما الذي يجعل المستخدمين يختارونهم؟

## ⚠️ مشاكل وشكاوى المنافسين
ابحث في Reddit وTrustpilot ومراجعات المستخدمين عن أكثر الشكاوى تكراراً (حدود الحجم، الاشتراك المدفوع، الإعلانات، الخصوصية، البطء...). هذه نقاط نستغلها.

## 🚀 كيف جلبوا الـ Traffic (الأهم)
اشرح بدقة كيف بنى هؤلاء المنافسون زياراتهم الضخمة:
- استراتيجية الـ SEO (أي كلمات يتصدرون فيها؟ صفحات هبوط لكل أداة؟ بلوج؟)
- الباك-لينكس (من أين يحصلون على روابط؟)
- المحتوى (مقالات إرشادية؟ أدلة؟)
- السوشيال ميديا والقنوات الأخرى
- أي تكتيك نمو محدد يمكن لـ Doctor PDF تقليده

## 🧩 فجوة الأدوات
قارن أدوات Doctor PDF أعلاه بأدوات المنافسين، واذكر بوضوح: ما الأدوات الموجودة عندهم وغير موجودة عند Doctor PDF؟ رتّبها حسب حجم الطلب (خاصة في السوق العربي) وحدّد لكل واحدة: هل يمكن تنفيذها داخل المتصفح بالكامل (بدون خادم)؟

اكتب كل شيء بالعربية، محدداً وعملياً وقابلاً للتنفيذ."""

    message = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=4000,
        tools=[{"type": "web_search_20250305", "name": "web_search"}],
        messages=[{"role": "user", "content": search_prompt}]
    )
    result_text = ""
    for block in message.content:
        if block.type == "text":
            result_text += block.text
    return result_text

# ── 4. GENERATE STRATEGIC REPORT ──
def generate_strategic_report(site_data, competitor_analysis, gsc_text):
    today = datetime.now().strftime('%Y-%m-%d')
    week_num = datetime.now().isocalendar()[1]

    gsc_block = gsc_text if gsc_text else "(لا توجد بيانات Search Console هذا الأسبوع)"

    synthesis_prompt = f"""أنت مستشار نمو استراتيجي لموقع Doctor PDF (أدوات PDF مجانية 100% داخل المتصفح، يستهدف السوق العربي أولاً). اكتب تقريراً أسبوعياً تنفيذياً مبنياً على البيانات التالية.

== حالة الموقع ==
التاريخ: {today} | أسبوع: {week_num}
أدوات تعمل: {len(site_data['working'])}/{site_data['total']} ({site_data['uptime_pct']}%)
أدوات معطلة: {', '.join(site_data['broken']) if site_data['broken'] else 'لا يوجد ✅'}

== بيانات الزوار الحقيقية (Search Console) ==
{gsc_block}

== تحليل المنافسين (بحث مباشر) ==
{competitor_analysis}

اكتب التقرير بهذا الهيكل بالضبط:

## 📊 ملخص الأسبوع
(3 جمل: أهم رقم من بياناتك + أهم ملاحظة عن المنافسين + التوجّه العام)

## 🎯 قرارات هذا الأسبوع (نفّذها الآن)
رتّب 1-3 مهام فقط حسب الأولوية (الأعلى تأثيراً أولاً). لكل مهمة: ماذا تفعل بالضبط + لماذا (مدعوماً برقم من البيانات) + الأثر المتوقع. ركّز على المكاسب السريعة (فرص الترتيب 5-20، أو أداة سهلة ناقصة).

## 🧩 فجوة الأدوات — الأولوية
من تحليل المنافسين، ما أهم أداة ناقصة يجب أن نبنيها؟ (واحدة فقط) ولماذا، وهل يمكن تنفيذها داخل المتصفح؟

## ⚠️ استغلال نقاط ضعف المنافسين
نقطة ضعف واحدة عند المنافسين + كيف نسوّق ضدها هذا الأسبوع.

## 📈 خطة الكلمات المفتاحية
3 كلمات عربية محددة نستهدفها هذا الأسبوع (يفضّل من فرص الترتيب 5-20 إن وُجدت) + لماذا كل واحدة.

## ⚠️ تحذيرات
أي مشكلة تقنية أو تهديد يجب معالجته فوراً (أو "لا يوجد ✅").

اجعل كل نقطة قابلة للتنفيذ خلال أسبوع. استشهد بالأرقام الحقيقية من البيانات كلما أمكن."""

    message = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=2500,
        messages=[{"role": "user", "content": synthesis_prompt}]
    )
    return message.content[0].text

# ── MAIN ──
print("🔍 Checking Doctor PDF tools...")
site_data = check_site()
print(f"✅ Site: {len(site_data['working'])}/{site_data['total']} tools working")

print("\n📊 Fetching Google Search Console data...")
gsc_text = fetch_gsc_data()

print("\n🌐 Analyzing competitors with web search...")
competitor_analysis = analyze_competitors()
print("✅ Competitor analysis complete")

print("\n📝 Generating strategic report...")
report = generate_strategic_report(site_data, competitor_analysis, gsc_text)
print("✅ Report generated")

# ── SAVE REPORT ──
today = datetime.now().strftime('%Y-%m-%d')
os.makedirs('reports', exist_ok=True)
report_path = f'reports/weekly-report-{today}.md'

full_report = f"""# Doctor PDF — تقرير استراتيجي أسبوعي {today}

**Uptime:** {site_data['uptime_pct']}% | **أدوات:** {len(site_data['working'])}/{site_data['total']}
{f"**⚠️ مشاكل:** {', '.join(site_data['broken'])}" if site_data['broken'] else "**✅ كل الأدوات تعمل**"}

---

{report}

---

{gsc_text if gsc_text else ''}

---

## 📋 تحليل المنافسين الكامل
{competitor_analysis}

---
*تم الإنشاء تلقائياً بواسطة Claude AI مع بحث مباشر + بيانات Search Console — {today}*
"""

with open(report_path, 'w', encoding='utf-8') as f:
    f.write(full_report)

print(f"\n📄 Report saved: {report_path}")
print("\n" + "="*60)
print(report)
print("="*60)

# ── GITHUB SUMMARY ──
summary_file = os.environ.get('GITHUB_STEP_SUMMARY', '/dev/null')
with open(summary_file, 'w', encoding='utf-8') as f:
    f.write(f"# 🩺 Doctor PDF — تقرير {today}\n\n")
    f.write(f"**Uptime:** {site_data['uptime_pct']}% | **Tools:** {len(site_data['working'])}/{site_data['total']}\n\n")
    if site_data['broken']:
        f.write(f"**⚠️ Issues:** {', '.join(site_data['broken'])}\n\n")
    f.write("---\n\n")
    f.write(report)

# ── SEND EMAIL (only if RESEND vars present in this step) ──
resend_key = os.environ.get('RESEND_API_KEY','')
report_email = os.environ.get('REPORT_EMAIL','')

if resend_key and report_email:
    import html as html_lib
    email_html = f"""
<div dir="rtl" style="font-family:Arial,sans-serif;max-width:700px;margin:auto;padding:20px;background:#fff">
  <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:20px;border-radius:12px;margin-bottom:20px">
    <h1 style="color:#fff;margin:0;font-size:22px">🩺 Doctor PDF</h1>
    <p style="color:rgba(255,255,255,.8);margin:5px 0 0">تقرير استراتيجي أسبوعي — {today}</p>
  </div>
  <div style="background:#f0fdf4;border:1px solid #22c55e;border-radius:8px;padding:12px;margin-bottom:16px">
    <strong style="color:#22c55e">✅ Uptime: {site_data['uptime_pct']}%</strong> |
    الأدوات: {len(site_data['working'])}/{site_data['total']}
    {f'<br><strong style="color:#ef4444">⚠️ مشاكل: {", ".join(site_data["broken"])}</strong>' if site_data['broken'] else ''}
  </div>
  <div style="background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:20px;line-height:1.8;font-size:14px;white-space:pre-wrap">
{html_lib.escape(report)}
  </div>
  <details style="margin-top:16px">
    <summary style="cursor:pointer;font-weight:600;color:#6366f1">📋 تحليل المنافسين الكامل + بيانات الزوار</summary>
    <div style="background:#f8f8f8;border-radius:8px;padding:16px;margin-top:8px;font-size:13px;line-height:1.7;white-space:pre-wrap">
{html_lib.escape(((gsc_text or '') + '\n\n' + competitor_analysis)[:4000])}
    </div>
  </details>
  <p style="color:#888;font-size:12px;margin-top:20px;text-align:center">
    تم الإنشاء تلقائياً بواسطة Claude AI مع بحث مباشر + Search Console
  </p>
</div>
"""
    r = requests.post(
        'https://api.resend.com/emails',
        headers={'Authorization': f'Bearer {resend_key}', 'Content-Type': 'application/json'},
        json={
            'from': 'Doctor PDF Bot <onboarding@resend.dev>',
            'to': [report_email],
            'subject': f'🩺 Doctor PDF — تقرير استراتيجي {today}',
            'html': email_html
        }
    )
    if r.status_code == 200:
        print("✅ Email sent successfully!")
    else:
        print(f"❌ Email failed: {r.status_code} {r.text}")
else:
    print("⚠️ Email skipped — RESEND_API_KEY or REPORT_EMAIL not set (workflow sends separately)")
