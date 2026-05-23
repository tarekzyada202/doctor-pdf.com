import anthropic
import requests
import os
from datetime import datetime

client = anthropic.Anthropic(api_key=os.environ['ANTHROPIC_API_KEY'])

# ── 1. CHECK OUR SITE ──
def check_site():
    tools = [
        'compress-pdf','stamp-pdf','rotate-pdf','merge-pdf',
        'split-pdf','sign-pdf','protect-pdf','watermark-pdf',
        'image-to-pdf','pdf-to-image','extract-text',
        'convert-image','remove-background'
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

# ── 2. DEEP COMPETITOR ANALYSIS via Claude + Web Search ──
def analyze_competitors():
    """Use Claude with web_search to analyze competitors and extract actionable insights."""
    
    competitors = ['ilovepdf.com', 'smallpdf.com', 'pdf24.org', 'sejda.com', 'ilovepdf.com']
    
    search_prompt = f"""
أنت محلل استراتيجي متخصص في مواقع أدوات PDF. مهمتك تحليل المنافسين واستخراج توصيات عملية لموقع Doctor PDF.

ابحث عن المعلومات التالية لكل منافس ({', '.join(competitors)}):

1. **الميزات الجديدة**: ما الأدوات أو الميزات التي أضافوها مؤخراً؟
2. **شكاوى المستخدمين**: ما أكثر الشكاوى على Reddit وTrustpilot والمراجعات؟
3. **نقاط الضعف**: ما القيود التي يفرضونها (حجم الملف، عدد العمليات، الاشتراك المدفوع)؟
4. **استراتيجية SEO**: ما الكلمات المفتاحية التي يتصدرون فيها؟
5. **UX والتصميم**: ما الجديد في واجهاتهم؟

بعد التحليل، قدم:
- قائمة بـ **5 ميزات** يجب أن يضيفها Doctor PDF فوراً بناءً على ما يفتقده المنافسون
- قائمة بـ **3 نقاط ضعف** عند المنافسين يمكن استغلالها
- **خطة SEO** محددة: 5 كلمات مفتاحية عربية يجب استهدافها
- **أولوية الأسبوع القادم**: مهمة واحدة فقط ذات أعلى تأثير

اكتب التقرير بالعربية بشكل منظم وعملي قابل للتنفيذ.
"""

    message = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=3000,
        tools=[{"type": "web_search_20250305", "name": "web_search"}],
        messages=[{"role": "user", "content": search_prompt}]
    )
    
    # Extract text from response (handle tool use blocks)
    result_text = ""
    for block in message.content:
        if block.type == "text":
            result_text += block.text
    
    return result_text

# ── 3. GENERATE STRATEGIC REPORT ──
def generate_strategic_report(site_data, competitor_analysis):
    today = datetime.now().strftime('%Y-%m-%d')
    week_num = datetime.now().isocalendar()[1]
    
    synthesis_prompt = f"""
أنت مستشار استراتيجي لموقع Doctor PDF. بناءً على البيانات التالية، اكتب تقريراً أسبوعياً استراتيجياً.

== حالة موقعنا ==
التاريخ: {today} | أسبوع: {week_num}
أدوات تعمل: {len(site_data['working'])}/{site_data['total']} ({site_data['uptime_pct']}%)
أدوات معطلة: {', '.join(site_data['broken']) if site_data['broken'] else 'لا يوجد ✅'}

== تحليل المنافسين (من البحث المباشر) ==
{competitor_analysis}

اكتب التقرير بهذا الهيكل:

## 📊 ملخص الأسبوع
(3 جمل فقط - أهم ما حدث)

## 🔍 أبرز ما وجدناه عند المنافسين
(نقاط محددة قابلة للتنفيذ)

## ⚡ الفرص الفورية لـ Doctor PDF
(ميزات يمكننا إضافتها هذا الأسبوع للتفوق على المنافسين)

## 🎯 هدف الأسبوع القادم
(مهمة واحدة فقط - الأعلى تأثيراً على النمو)

## 📈 SEO هذا الأسبوع
(3 كلمات مفتاحية عربية محددة نستهدفها + لماذا)

## ⚠️ تحذيرات
(أي مشاكل يجب معالجتها فوراً)

اجعل التقرير عملياً 100% - كل نقطة قابلة للتنفيذ خلال أسبوع.
"""

    message = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=2000,
        messages=[{"role": "user", "content": synthesis_prompt}]
    )
    
    return message.content[0].text

# ── MAIN ──
print("🔍 Checking Doctor PDF tools...")
site_data = check_site()
print(f"✅ Site: {len(site_data['working'])}/{site_data['total']} tools working")

print("\n🌐 Analyzing competitors with web search...")
competitor_analysis = analyze_competitors()
print("✅ Competitor analysis complete")

print("\n📝 Generating strategic report...")
report = generate_strategic_report(site_data, competitor_analysis)
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

## 📋 تحليل المنافسين الكامل
{competitor_analysis}

---
*تم الإنشاء تلقائياً بواسطة Claude AI مع بحث مباشر على الإنترنت — {today}*
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

# ── SEND EMAIL ──
resend_key = os.environ.get('RESEND_API_KEY','')
report_email = os.environ.get('REPORT_EMAIL','')

if resend_key and report_email:
    import html as html_lib
    report_html = full_report.replace('\n', '<br>').replace('## ', '<h3>').replace('**', '<strong>')
    
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
    <summary style="cursor:pointer;font-weight:600;color:#6366f1">📋 تحليل المنافسين الكامل</summary>
    <div style="background:#f8f8f8;border-radius:8px;padding:16px;margin-top:8px;font-size:13px;line-height:1.7;white-space:pre-wrap">
{html_lib.escape(competitor_analysis[:3000])}
    </div>
  </details>

  <p style="color:#888;font-size:12px;margin-top:20px;text-align:center">
    تم الإنشاء تلقائياً بواسطة Claude AI مع بحث مباشر على الإنترنت
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
    print("⚠️ Email skipped — RESEND_API_KEY or REPORT_EMAIL not set")
