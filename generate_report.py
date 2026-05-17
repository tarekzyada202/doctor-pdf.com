import anthropic
import requests
import os
from datetime import datetime

client = anthropic.Anthropic(api_key=os.environ['ANTHROPIC_API_KEY'])

def check_site():
    tools = [
        'compress-pdf', 'stamp-pdf', 'rotate-pdf', 'merge-pdf',
        'split-pdf', 'sign-pdf', 'protect-pdf', 'watermark-pdf',
        'image-to-pdf', 'pdf-to-image', 'extract-text',
        'convert-image', 'remove-background'
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

def check_competitors():
    competitors = {
        'ilovepdf.com': 'ilovePDF', 'smallpdf.com': 'Smallpdf',
        'pdf24.org': 'PDF24', 'sejda.com': 'Sejda', 'revpdf.com': 'RevPDF'
    }
    data = []
    for domain, name in competitors.items():
        try:
            r = requests.get(f'https://{domain}', timeout=10)
            data.append(f'{name}: Online (HTTP {r.status_code})')
        except:
            data.append(f'{name}: Unreachable')
    return data

print("Checking site...")
site_data = check_site()
print("Checking competitors...")
comp_data = check_competitors()

today = datetime.now().strftime('%Y-%m-%d')
week_num = datetime.now().isocalendar()[1]

prompt = f"""أنت مستشار خبير في تطوير مواقع PDF Tools. اكتب تقرير أسبوعي احترافي لموقع Doctor PDF.

== بيانات هذا الأسبوع ==
التاريخ: {today} | أسبوع رقم: {week_num}

== حالة الموقع ==
الأدوات الشغالة ({len(site_data['working'])}/{site_data['total']}): {', '.join(site_data['working'])}
الأدوات المعطلة: {', '.join(site_data['broken']) if site_data['broken'] else 'لا يوجد'}
نسبة الـ Uptime: {site_data['uptime_pct']}%

== حالة المنافسين ==
{chr(10).join(comp_data)}

== معلومات الموقع ==
- doctor-pdf.com | 13 أداة PDF مجانية | browser-based
- اللغات: عربي + إنجليزي | Cloudflare Pages

اكتب التقرير بالعربية:
1. ملخص الأسبوع
2. حالة الموقع والأدوات
3. تحليل المنافسين
4. أولويات الأسبوع القادم (3 مهام)
5. نصيحة استراتيجية واحدة
"""

print("Generating AI report...")
message = client.messages.create(
    model="claude-haiku-4-5",
    max_tokens=1500,
    messages=[{"role": "user", "content": prompt}]
)

report_text = message.content[0].text
os.makedirs('reports', exist_ok=True)
report_path = f'reports/weekly-report-{today}.md'

with open(report_path, 'w', encoding='utf-8') as f:
    f.write(f"# Doctor PDF — تقرير أسبوعي {today}\n\n")
    f.write(f"**Uptime:** {site_data['uptime_pct']}% | **أدوات شغالة:** {len(site_data['working'])}/{site_data['total']}\n\n---\n\n")
    f.write(report_text)
    f.write(f"\n\n---\n*تم الإنشاء تلقائياً — {today}*\n")

print(f"Report saved: {report_path}")
print("\n" + "="*60)
print(report_text)
print("="*60)

summary_file = os.environ.get('GITHUB_STEP_SUMMARY', '/dev/null')
with open(summary_file, 'w') as f:
    f.write(f"# Doctor PDF Weekly Report {today}\n\n")
    f.write(f"**Uptime:** {site_data['uptime_pct']}% | **Tools:** {len(site_data['working'])}/{site_data['total']}\n\n")
    if site_data['broken']:
        f.write(f"**Issues:** {', '.join(site_data['broken'])}\n\n")
    f.write("---\n\n")
    f.write(report_text)
