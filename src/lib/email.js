import { escapeHtml } from '../render/msn.js';

const FROM = 'Camp Planner <camp@robot.cuuush.com>';
const SITE = 'https://camp.cuuush.com';

// A notification e-mail dressed as a Windows XP dialog: Luna-blue title bar,
// the classic #ECE9D8 dialog face, Tahoma, an info icon, and an OK button that
// opens the site — sitting on the default XP desktop blue. Table layout with
// inline styles only, because e-mail clients strip <style> blocks and external
// CSS; the remote dlg-info icon degrades to nothing when images are blocked.
//
// heading/body arrive as PLAIN TEXT (camper-typed comment text flows in here)
// and are escaped — a message like "<img src=…>" must render as its characters,
// never as live HTML in someone else's inbox.
function xpTemplate({ heading, body, unsubscribeUrl }) {
    const safeHeading = escapeHtml(heading);
    const safeBody = escapeHtml(body);
    return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#3A6EA5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#3A6EA5;">
    <tr><td align="center" style="padding:32px 10px;">

      <table role="presentation" cellpadding="0" cellspacing="0" width="480" style="width:480px;max-width:100%;">
        <tr>
          <td style="background-color:#0054E3;background-image:linear-gradient(180deg,#3D95FF 0%,#0054E3 14%,#0054E3 86%,#0040AB 100%);border-radius:8px 8px 0 0;padding:6px 12px;font-family:'Trebuchet MS',Tahoma,Verdana,sans-serif;font-size:14px;font-weight:bold;color:#ffffff;">
            Camp Planner
          </td>
        </tr>
        <tr>
          <td style="background-color:#ECE9D8;border-left:3px solid #0054E3;border-right:3px solid #0054E3;border-bottom:3px solid #0054E3;padding:18px 16px 14px;">
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <td width="44" valign="top" style="padding-right:4px;">
                  <img src="${SITE}/xp/dlg-info.png" width="32" height="32" alt="" style="display:block;">
                </td>
                <td valign="top" style="font-family:Tahoma,Verdana,sans-serif;font-size:12px;color:#000000;line-height:1.5;">
                  <b>${safeHeading}</b><br><br>
                  ${safeBody}
                </td>
              </tr>
            </table>
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <td align="center" style="padding:18px 0 6px;">
                  <a href="${SITE}/" style="display:inline-block;background-color:#ECE9D8;border:1px solid #003C74;border-radius:3px;padding:3px 28px;font-family:Tahoma,Verdana,sans-serif;font-size:12px;color:#000000;text-decoration:none;">OK</a>
                </td>
              </tr>
              <tr>
                <td style="border-top:1px solid #ACA899;padding-top:10px;font-family:Tahoma,Verdana,sans-serif;font-size:10px;color:#666666;line-height:1.5;">
                  You are receiving this message because e-mail notifications are turned on for your account.
                  To stop receiving these messages, <a href="${escapeHtml(unsubscribeUrl)}" style="color:#0046D5;">click here to unsubscribe</a>.
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>

    </td></tr>
  </table>
</body>
</html>`;
}

// Notifications never block the triggering action — failures are swallowed by the caller.
export async function sendNotificationEmail(env, { to, heading, body, unsubscribeUrl }) {
    if (!env.RESEND_API_KEY || !to) return;

    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: FROM,
            to: [to],
            subject: heading,
            html: xpTemplate({ heading, body, unsubscribeUrl }),
        }),
    });

    if (!res.ok) {
        console.error('Resend error:', await res.text());
    }
}
