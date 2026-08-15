// Sends order-status notification emails to customers via Gmail SMTP.
//
// Requires two env vars (see .env):
//   EMAIL_USER          - the Gmail address to send from
//   EMAIL_APP_PASSWORD   - a Gmail "App Password" for that account (NOT the
//                          normal login password - Gmail requires 2-Step
//                          Verification to be enabled before it will issue one)
//
// If those env vars aren't set, sendOrderStatusEmail() silently no-ops
// (logged once) so the rest of the app keeps working without email configured.
const nodemailer = require("nodemailer");

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_APP_PASSWORD = process.env.EMAIL_APP_PASSWORD;
const isConfigured = Boolean(EMAIL_USER && EMAIL_APP_PASSWORD);

if (!isConfigured) {
  console.warn(
    "[mailer] EMAIL_USER / EMAIL_APP_PASSWORD not set - order status emails are disabled."
  );
}

const transporter = isConfigured
  ? nodemailer.createTransport({
      service: "gmail",
      auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD },
    })
  : null;

const FROM = `"Book Ocean BD" <${EMAIL_USER}>`;

const COPY = {
  approve: {
    subject: "Your Book Ocean BD order has been approved",
    headline: "Good news - your order has been approved!",
    body: "We're getting your books ready. You'll be notified again once your order is out for delivery.",
  },
  canceled: {
    subject: "Your Book Ocean BD order has been canceled",
    headline: "Your order has been canceled",
    body: "If this wasn't expected or you have any questions, just reply to this email and we'll help sort it out.",
  },
  delivered: {
    subject: "Your Book Ocean BD order has been delivered",
    headline: "Your order has been delivered!",
    body: "Thanks for shopping with Book Ocean BD - we hope you enjoy your books.",
  },
};

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildEmailHtml(order, status) {
  const copy = COPY[status];
  const items = (order.cart || [])
    .map((book) => {
      const price = book.discountPrice ?? book.price ?? "";
      return `<li>${escapeHtml(book.name)}${book.author ? ` — by ${escapeHtml(book.author)}` : ""} (৳${price})</li>`;
    })
    .join("");

  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1e293b;">
      <h2 style="margin-bottom: 4px;">Book Ocean BD</h2>
      <p>Hi ${escapeHtml(order.data?.name) || "there"},</p>
      <p style="font-size: 16px; font-weight: bold;">${copy.headline}</p>
      <p>${copy.body}</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px;">
        <tr><td style="padding: 4px 0; color:#64748b;">Order date</td><td style="text-align:right;">${escapeHtml(order.date)}</td></tr>
        <tr><td style="padding: 4px 0; color:#64748b;">Total</td><td style="text-align:right;">৳${order.totalAmount ?? ""}</td></tr>
      </table>
      <ul style="font-size: 14px; padding-left: 20px;">${items}</ul>
      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
      <p style="font-size: 12px; color: #64748b;">Questions about your order? Just reply to this email.</p>
    </div>
  `;
}

// order: the order document (must have .email, .data.name, .cart, .date, .totalAmount)
// status: 'approve' | 'canceled' | 'delivered'
async function sendOrderStatusEmail(order, status) {
  if (!isConfigured) return;
  if (!order?.email) {
    console.warn(`[mailer] order ${order?._id} has no customer email on file, skipping notification.`);
    return;
  }
  const copy = COPY[status];
  if (!copy) {
    console.warn(`[mailer] no email template for status "${status}", skipping.`);
    return;
  }

  await transporter.sendMail({
    from: FROM,
    to: order.email,
    subject: copy.subject,
    html: buildEmailHtml(order, status),
  });
}

module.exports = { sendOrderStatusEmail };
