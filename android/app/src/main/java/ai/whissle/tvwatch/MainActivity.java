package ai.whissle.tvwatch;

import android.Manifest;
import android.animation.ObjectAnimator;
import android.animation.ValueAnimator;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.text.SpannableStringBuilder;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Iterator;

/** One screen that fits the phone: top bar, sport chips, scoreboard, then a Live / Alerts panel that takes the rest.
 *  The Pi's address, connect / stop and a test alert live behind the gear. */
public class MainActivity extends Activity implements WatchService.Listener {
    static final int BG = 0xFF0B0D12, CARD = 0xFF151821, CARD2 = 0xFF1C2030, LINE = 0xFF262B3A, INK = 0xFFF2F4F8,
            MUTE = 0xFF8B93A7, ACCENT = 0xFF3B82F6, LIVE = 0xFFFF4D4F, OK = 0xFF34D399, GOLD = 0xFFF5C542;

    private TextView statusText, statusDot, score, clock, clockLabel, sportLabel, livePill, partial, sound,
            tabLive, tabAlerts, tabRecap, banner, emptyAlerts;
    private LinearLayout recapBody;
    private TextView mic, heat;
    private LinearLayout watching;
    private final java.util.Map<Integer, TextView[]> alertViews = new java.util.HashMap<>();   // aid -> title, body
    private View levelBar;
    private ScrollView recapScroll;
    private int tabShown;   // 0 live, 1 alerts, 2 recap
    private LinearLayout transcript, alertList, sportRow, livePanel;
    private ScrollView liveScroll, alertScroll;
    private HorizontalScrollView sportScroll;
    private String domain = "";
    private JSONObject sports;
    private int alertCount;
    private boolean onAlertsTab;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);

        LinearLayout root = column();
        root.setBackgroundColor(BG);
        root.setOnApplyWindowInsetsListener((v, ins) -> {   // edge to edge: keep clear of the status / nav bars
            Insets i = ins.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            v.setPadding(i.left + dp(16), i.top + dp(8), i.right + dp(16), i.bottom + dp(10));
            return WindowInsets.CONSUMED;
        });

        root.addView(topBar(), new LinearLayout.LayoutParams(-1, dp(48)));

        sportScroll = new HorizontalScrollView(this);
        sportScroll.setHorizontalScrollBarEnabled(false);
        sportRow = new LinearLayout(this);
        sportScroll.addView(sportRow);
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(-1, -2);
        sp.setMargins(0, dp(4), 0, dp(12));
        root.addView(sportScroll, sp);

        root.addView(scoreboard(), new LinearLayout.LayoutParams(-1, -2));
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(-1, dp(40));
        tp.setMargins(0, dp(12), 0, dp(10));
        root.addView(tabs(), tp);
        root.addView(panel(), new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(root);

        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
    }

    // ---------------------------------------------------------------- layout
    private View topBar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout brand = column();
        TextView name = text("TV Watch", 21, INK);
        name.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
        brand.addView(name);
        brand.addView(text("Arc on Raspberry Pi", 11, MUTE));
        bar.addView(brand, new LinearLayout.LayoutParams(0, -2, 1));

        heat = text("", 12, INK);
        heat.setGravity(Gravity.CENTER);
        heat.setPadding(dp(10), 0, dp(10), 0);
        heat.setVisibility(View.GONE);
        heat.setOnClickListener(v -> android.widget.Toast.makeText(this,
                "The Pi is hot and slowing down. A cooler (or some airflow) keeps it real-time.",
                android.widget.Toast.LENGTH_LONG).show());
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(-2, dp(32));
        hp.setMargins(0, 0, dp(8), 0);
        bar.addView(heat, hp);

        LinearLayout pill = new LinearLayout(this);
        pill.setGravity(Gravity.CENTER_VERTICAL);
        pill.setPadding(dp(10), 0, dp(12), 0);
        pill.setBackground(round(CARD, dp(16), LINE));
        statusDot = text("●", 11, MUTE);
        statusText = text("Offline", 13, MUTE);
        statusText.setPadding(dp(6), 0, 0, 0);
        pill.addView(statusDot);
        pill.addView(statusText);
        pill.setOnClickListener(v -> settings());
        bar.addView(pill, new LinearLayout.LayoutParams(-2, dp(32)));

        TextView gear = text("⚙", 18, INK);
        gear.setGravity(Gravity.CENTER);
        gear.setBackground(round(CARD, dp(16), LINE));
        gear.setOnClickListener(v -> settings());
        LinearLayout.LayoutParams gp = new LinearLayout.LayoutParams(dp(32), dp(32));
        gp.setMargins(dp(8), 0, 0, 0);
        bar.addView(gear, gp);
        return bar;
    }

    private View scoreboard() {
        LinearLayout card = column();
        card.setPadding(dp(18), dp(14), dp(18), dp(16));
        GradientDrawable g = new GradientDrawable(GradientDrawable.Orientation.TL_BR, new int[]{0xFF1E2A4A, 0xFF141826});
        g.setCornerRadius(dp(20));
        g.setStroke(dp(1), 0xFF2A3656);
        card.setBackground(g);

        LinearLayout head = new LinearLayout(this);
        head.setGravity(Gravity.CENTER_VERTICAL);
        sportLabel = text("—", 13, 0xFFB8C2DC);
        sportLabel.setTypeface(Typeface.DEFAULT_BOLD);
        sportLabel.setLetterSpacing(0.06f);
        sportLabel.setSingleLine(true);
        sportLabel.setEllipsize(TextUtils.TruncateAt.END);
        head.addView(sportLabel, new LinearLayout.LayoutParams(0, -2, 1));
        livePill = text("● LIVE", 11, INK);
        livePill.setTypeface(Typeface.DEFAULT_BOLD);
        livePill.setLetterSpacing(0.08f);
        livePill.setPadding(dp(8), dp(2), dp(8), dp(2));
        livePill.setBackground(round(LIVE, dp(10), 0));
        livePill.setVisibility(View.INVISIBLE);
        head.addView(livePill);
        card.addView(head);

        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.BOTTOM);
        row.setPadding(0, dp(6), 0, 0);
        score = text("– : –", 46, INK);
        score.setTypeface(Typeface.create("sans-serif-condensed", Typeface.BOLD));
        score.setFontFeatureSettings("tnum");
        score.setIncludeFontPadding(false);
        score.setSingleLine(true);
        row.addView(score, new LinearLayout.LayoutParams(0, -2, 1));
        LinearLayout c = column();
        c.setGravity(Gravity.END);
        clockLabel = text("CLOCK", 11, MUTE);
        clockLabel.setLetterSpacing(0.1f);
        clock = text("–", 28, INK);
        clock.setTypeface(Typeface.create("sans-serif-condensed", Typeface.BOLD));
        clock.setFontFeatureSettings("tnum");
        clock.setIncludeFontPadding(false);
        c.addView(clockLabel);
        c.addView(clock);
        row.addView(c);
        card.addView(row);
        return card;
    }

    private View tabs() {
        LinearLayout seg = new LinearLayout(this);
        seg.setPadding(dp(3), dp(3), dp(3), dp(3));
        seg.setBackground(round(CARD, dp(12), LINE));
        tabLive = tab("Live");
        tabAlerts = tab("Alerts");
        tabRecap = tab("Last 30 min");
        tabLive.setOnClickListener(v -> showTab(0));
        tabAlerts.setOnClickListener(v -> showTab(1));
        tabRecap.setOnClickListener(v -> showTab(2));
        seg.addView(tabLive, new LinearLayout.LayoutParams(0, -1, 1));
        seg.addView(tabAlerts, new LinearLayout.LayoutParams(0, -1, 1));
        seg.addView(tabRecap, new LinearLayout.LayoutParams(0, -1, 1.25f));
        return seg;
    }

    private View panel() {
        FrameLayout frame = new FrameLayout(this);
        frame.setBackground(round(CARD, dp(18), LINE));
        frame.setClipToOutline(true);

        // live: legend, transcript, the sentence being spoken
        livePanel = column();
        LinearLayout head = new LinearLayout(this);
        head.setGravity(Gravity.CENTER_VERTICAL);
        head.setPadding(dp(14), dp(12), dp(14), dp(8));
        head.addView(legend(), new LinearLayout.LayoutParams(0, -2, 1));
        sound = text("", 11, MUTE);
        head.addView(sound);
        mic = text("🎙 Phone mic", 12, MUTE);
        mic.setGravity(Gravity.CENTER);
        mic.setPadding(dp(10), 0, dp(10), 0);
        mic.setOnClickListener(v -> toggleMic());
        LinearLayout.LayoutParams mp = new LinearLayout.LayoutParams(-2, dp(28));
        mp.setMargins(dp(8), 0, 0, 0);
        head.addView(mic, mp);
        styleMic();
        livePanel.addView(head);
        FrameLayout meter = new FrameLayout(this);   // what the Pi hears: place the mic so this moves with the TV
        meter.setBackgroundColor(LINE);
        levelBar = new View(this);
        levelBar.setBackgroundColor(OK);
        meter.addView(levelBar, new FrameLayout.LayoutParams(0, -1));
        livePanel.addView(meter, new LinearLayout.LayoutParams(-1, dp(3)));
        liveScroll = new ScrollView(this);
        liveScroll.setVerticalScrollBarEnabled(false);
        LinearLayout body = column();
        body.setPadding(dp(16), dp(8), dp(16), dp(16));
        transcript = column();
        body.addView(transcript);
        partial = text("Waiting for the Pi…", 17, MUTE);
        partial.setLineSpacing(dp(3), 1f);
        partial.setPadding(0, dp(8), 0, 0);
        body.addView(partial);
        liveScroll.addView(body);
        livePanel.addView(liveScroll, new LinearLayout.LayoutParams(-1, 0, 1));
        frame.addView(livePanel, new FrameLayout.LayoutParams(-1, -1));

        // alerts
        alertScroll = new ScrollView(this);
        alertScroll.setVerticalScrollBarEnabled(false);
        LinearLayout ab = column();
        ab.setPadding(dp(12), dp(12), dp(12), dp(12));
        watching = column();
        ab.addView(watching);
        emptyAlerts = text("No alerts yet.\nRules for this sport fire here and on your lock screen.", 15, MUTE);
        emptyAlerts.setGravity(Gravity.CENTER);
        emptyAlerts.setPadding(dp(16), dp(48), dp(16), 0);
        ab.addView(emptyAlerts);
        alertList = column();
        ab.addView(alertList);
        alertScroll.addView(ab);
        frame.addView(alertScroll, new FrameLayout.LayoutParams(-1, -1));

        // recap: the Pi's memory of the last 30 minutes
        recapScroll = new ScrollView(this);
        recapScroll.setVerticalScrollBarEnabled(false);
        recapBody = column();
        recapBody.setPadding(dp(16), dp(14), dp(16), dp(16));
        recapScroll.addView(recapBody);
        frame.addView(recapScroll, new FrameLayout.LayoutParams(-1, -1));

        // the newest alert, shown over the live panel for a few seconds
        banner = text("", 14, INK);
        banner.setPadding(dp(14), dp(10), dp(14), dp(10));
        banner.setBackground(round(0xF2331A1E, dp(12), 0x88FF4D4F));
        banner.setMaxLines(2);
        banner.setEllipsize(TextUtils.TruncateAt.END);
        banner.setVisibility(View.GONE);
        banner.setOnClickListener(v -> showTab(1));
        FrameLayout.LayoutParams bp = new FrameLayout.LayoutParams(-1, -2, Gravity.TOP);
        bp.setMargins(dp(10), dp(10), dp(10), 0);
        frame.addView(banner, bp);

        showTab(0);
        return frame;
    }

    private void showTab(int which) {
        tabShown = which;
        onAlertsTab = which == 1;
        styleTab(tabLive, which == 0);
        styleTab(tabAlerts, which == 1);
        styleTab(tabRecap, which == 2);
        livePanel.setVisibility(which == 0 ? View.VISIBLE : View.GONE);
        alertScroll.setVisibility(which == 1 ? View.VISIBLE : View.GONE);
        recapScroll.setVisibility(which == 2 ? View.VISIBLE : View.GONE);
        if (which != 0) banner.setVisibility(View.GONE);
        if (which == 1) {
            alertCount = 0;
            tabAlerts.setText("Alerts");
            loadWatching();
        }
        recapBody.removeCallbacks(refreshRecap);
        if (which == 2) refreshRecap.run();
    }

    /** what the Pi is listening for in this sport: names (removable) and the sport's alert words */
    private void loadWatching() {
        String h = WatchService.host;
        if (h == null) return;
        new Thread(() -> {
            String body = Finder.get(h, "/api/state", 4000);
            if (body == null) return;
            runOnUiThread(() -> {
                try {
                    drawWatching(new JSONObject(body));
                } catch (Exception ignored) {
                }
            });
        }).start();
    }

    private void drawWatching(JSONObject st) {
        watching.removeAllViews();
        JSONArray rules = st.optJSONArray("rules");
        JSONArray active = st.optJSONArray("active");
        java.util.Set<String> on = new java.util.HashSet<>();
        for (int i = 0; active != null && i < active.length(); i++) on.add(active.optString(i));
        TextView head = text("LISTENING FOR · " + shortName(domain).toUpperCase(), 11, MUTE);
        head.setLetterSpacing(0.1f);
        head.setTypeface(Typeface.DEFAULT_BOLD);
        head.setPadding(dp(4), 0, 0, dp(6));
        watching.addView(head);
        org.json.JSONArray list = rules == null ? new JSONArray() : rules;
        LinearLayout row = null;
        int inRow = 0;
        for (int i = 0; i < list.length(); i++) {
            JSONObject r = list.optJSONObject(i);
            if (!on.contains(r.optString("id"))) continue;
            String label = ruleLabel(r);
            if (label == null) continue;
            if (row == null || inRow == 2) {
                row = new LinearLayout(this);
                watching.addView(row);
                inRow = 0;
            }
            boolean name = r.optString("type").equals("name");
            TextView c = text(label + (name ? "  ✕" : ""), 13, name ? GOLD : 0xFFC4CAD8);
            c.setPadding(dp(10), dp(6), dp(10), dp(6));
            c.setSingleLine(true);
            c.setEllipsize(TextUtils.TruncateAt.END);
            c.setBackground(round(CARD2, dp(10), name ? 0x66F5C542 : 0));
            if (name) c.setOnClickListener(v -> new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                    .setTitle("Stop watching " + r.optString("name") + "?")
                    .setPositiveButton("Stop", (x, y) -> new Thread(() -> {
                        Finder.post(WatchService.host, "/api/rules/delete", "{\"id\":" + JSONObject.quote(r.optString("id")) + "}");
                        runOnUiThread(this::loadWatching);
                    }).start())
                    .setNegativeButton("Keep", null).show());
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, -2, 1);
            lp.setMargins(0, 0, dp(6), dp(6));
            row.addView(c, lp);
            inRow++;
        }
        if (row != null && inRow == 1) row.addView(new View(this), new LinearLayout.LayoutParams(0, 1, 1));
        TextView tip = text("Tap a name in the Live transcript to watch it.", 12, MUTE);
        tip.setPadding(dp(4), dp(2), 0, dp(12));
        watching.addView(tip);
    }

    private static String ruleLabel(JSONObject r) {
        switch (r.optString("type")) {
            case "name": return "★ " + r.optString("name");
            case "score_change": return "🔢 Score changes";
            case "lead_change": return "🔁 Lead changes";
            case "close_game": return "⚖️ Within " + r.optInt("margin", 3) + " pts";
            case "clock_under": return "⏱ Final minutes";
            case "game_back": return "▶️ Game is back";
            case "sound": return "🔥 Crowd erupts";
            case "keyword": {
                String t = r.optString("title");
                if (!t.isEmpty()) return t;
                JSONArray w = r.optJSONArray("words");
                return "🔤 " + (w != null && w.length() > 0 ? w.optString(0) : "words");
            }
            default: return null;
        }
    }

    /** fetch /api/catchup now and every 15 s while the tab is open */
    private final Runnable refreshRecap = new Runnable() {
        @Override
        public void run() {
            String h = WatchService.host;
            if (recapBody.getChildCount() == 0) recapBody.addView(text(h == null ? "Not connected." : "Loading…", 15, MUTE));
            if (h != null) new Thread(() -> {
                String body = Finder.get(h, "/api/catchup", 30000);
                runOnUiThread(() -> {
                    try {
                        if (body != null && tabShown == 2) drawRecap(new JSONObject(body));
                    } catch (Exception ignored) {
                    }
                });
            }).start();
            recapBody.postDelayed(this, 15000);
        }
    };

    private void drawRecap(JSONObject r) {
        recapBody.removeAllViews();
        LinearLayout titleRow = new LinearLayout(this);
        titleRow.setGravity(Gravity.CENTER_VERTICAL);
        TextView head = text("What you missed", 20, INK);
        head.setTypeface(Typeface.DEFAULT_BOLD);
        titleRow.addView(head, new LinearLayout.LayoutParams(0, -2, 1));
        TextView share = text("Share", 14, INK);
        share.setGravity(Gravity.CENTER);
        share.setPadding(dp(14), 0, dp(14), 0);
        share.setBackground(round(ACCENT, dp(14), 0));
        share.setOnClickListener(v -> shareRecap(r));
        titleRow.addView(share, new LinearLayout.LayoutParams(-2, dp(30)));
        recapBody.addView(titleRow);
        double mins = r.optDouble("minutes");
        recapBody.addView(text(String.format("The Pi remembers the last %d min · heard %d sentences, %d words so far (%s)",
                r.optInt("window"), r.optInt("sentences"), r.optInt("words"),
                mins < 1 ? "under a minute" : Math.round(mins) + " min"), 12, MUTE));

        String recap = r.isNull("recap") ? "" : r.optString("recap");
        if (!recap.isEmpty()) {
            TextView t = text(recap, 16, INK);
            t.setLineSpacing(dp(3), 1f);
            t.setPadding(dp(14), dp(12), dp(14), dp(12));
            t.setBackground(round(CARD2, dp(12), 0));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
            lp.setMargins(0, dp(12), 0, 0);
            recapBody.addView(t, lp);
        }

        JSONArray sc = r.optJSONArray("scores");
        if (sc != null && sc.length() > 0) {
            recapBody.addView(section("SCORE"));
            for (int i = 0; i < sc.length(); i++) {
                JSONObject o = sc.optJSONObject(i);
                JSONArray v = o.optJSONArray("score");
                LinearLayout row = new LinearLayout(this);
                row.setGravity(Gravity.CENTER_VERTICAL);
                row.setPadding(0, dp(4), 0, dp(4));
                TextView time = text(o.optString("time"), 12, MUTE);
                row.addView(time, new LinearLayout.LayoutParams(dp(46), -2));
                TextView big = text(v.optInt(0) + "–" + v.optInt(1), 20, INK);
                big.setTypeface(Typeface.create("sans-serif-condensed", Typeface.BOLD));
                row.addView(big, new LinearLayout.LayoutParams(dp(92), -2));
                TextView said = text(o.optString("said"), 13, 0xFFC4CAD8);
                said.setMaxLines(2);
                said.setEllipsize(TextUtils.TruncateAt.END);
                row.addView(said, new LinearLayout.LayoutParams(0, -2, 1));
                recapBody.addView(row);
            }
        }

        JSONArray top = r.optJSONArray("top");
        if (top != null && top.length() > 0) {
            recapBody.addView(section("MOST MENTIONED"));
            SpannableStringBuilder b = new SpannableStringBuilder();
            for (int i = 0; i < top.length(); i++) {
                JSONObject o = top.optJSONObject(i);
                String kind = o.optString("kind");
                String tag = kind.equals("person") ? "ENTITY_PERSON" : kind.equals("team") ? "ENTITY_TEAM"
                        : kind.equals("place") ? "ENTITY_PLACE" : "ENTITY_ORG";
                int st = b.length();
                b.append("\u00A0").append(o.optString("name").replace(' ', '\u00A0')).append("\u00A0×")
                        .append(String.valueOf(o.optInt("count"))).append("\u00A0");   // a chip never breaks mid-name
                Highlight.style(b, st, b.length(), tag, false);
                b.append("   ");
            }
            TextView t = text("", 15, INK);
            t.setText(b);
            t.setLineSpacing(dp(8), 1f);
            recapBody.addView(t);
        }

        JSONArray m = r.optJSONArray("moments");
        recapBody.addView(section("KEY MOMENTS"));
        if (m == null || m.length() == 0) recapBody.addView(text("Nothing your rules caught yet.", 14, MUTE));
        for (int i = 0; m != null && i < m.length(); i++) {
            JSONObject a = m.optJSONObject(i);
            LinearLayout row = new LinearLayout(this);
            row.setPadding(0, dp(5), 0, dp(5));
            row.addView(text(a.optString("time"), 12, MUTE), new LinearLayout.LayoutParams(dp(46), -2));
            LinearLayout col = column();
            TextView t = text(a.optString("title"), 15, INK);
            t.setTypeface(Typeface.DEFAULT_BOLD);
            col.addView(t);
            TextView body = text(a.optString("body"), 13, 0xFFC4CAD8);
            body.setMaxLines(2);
            body.setEllipsize(TextUtils.TruncateAt.END);
            col.addView(body);
            row.addView(col, new LinearLayout.LayoutParams(0, -2, 1));
            recapBody.addView(row);
        }
    }

    /** the recap as plain text, through the share sheet (a group chat: "you missed this") */
    private void shareRecap(JSONObject r) {
        StringBuilder b = new StringBuilder();
        String sport = sports != null ? sports.optString(r.optString("domain"), "") : "";
        b.append("📺 TV Watch · ").append(sport).append(" · last ").append(Math.max(1, Math.round(r.optDouble("minutes"))))
                .append(" min\n");
        JSONArray sc = r.optJSONArray("score");
        if (sc != null) b.append("Score: ").append(r.isNull("score_text") ? sc.optInt(0) + "–" + sc.optInt(1) : r.optString("score_text"))
                .append(r.isNull("clock") ? "" : "  (" + r.optString("clock") + ")").append("\n");
        if (!r.isNull("recap") && !r.optString("recap").isEmpty()) b.append("\n").append(r.optString("recap")).append("\n");
        JSONArray m = r.optJSONArray("moments");
        if (m != null && m.length() > 0) {
            b.append("\nKey moments\n");
            for (int i = m.length() - 1; i >= 0; i--) {
                JSONObject a = m.optJSONObject(i);
                b.append("• ").append(a.optString("time")).append("  ").append(a.optString("title")).append("\n");
            }
        }
        JSONArray top = r.optJSONArray("top");
        if (top != null && top.length() > 0) {
            b.append("\nMost mentioned: ");
            for (int i = 0; i < Math.min(5, top.length()); i++)
                b.append(i > 0 ? ", " : "").append(top.optJSONObject(i).optString("name"));
            b.append("\n");
        }
        b.append("\nHeard live on a Raspberry Pi by Arc");
        Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, b.toString());
        startActivity(Intent.createChooser(send, "Share the recap"));
    }

    private TextView section(String s) {
        TextView t = text(s, 11, MUTE);
        t.setLetterSpacing(0.1f);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, dp(18), 0, dp(6));
        return t;
    }

    /** the phone becomes the TV's microphone (no USB mic needed): asks for the mic permission the first time */
    private void toggleMic() {
        if (!WatchService.micOn && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 2);
            return;
        }
        Intent i = new Intent(this, WatchService.class)
                .setAction(WatchService.micOn ? WatchService.ACTION_MIC_OFF : WatchService.ACTION_MIC_ON);
        startForegroundService(i);
        mic.removeCallbacks(micMeter);
        mic.postDelayed(micMeter, 200);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        if (code == 2 && res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED) toggleMic();
    }

    private final Runnable micMeter = new Runnable() {
        @Override
        public void run() {
            styleMic();
            if (WatchService.micOn) mic.postDelayed(this, 150);
        }
    };

    private void styleMic() {
        boolean on = WatchService.micOn;
        if (!on) {
            mic.setText("🎙 Phone mic");
            mic.setTextColor(MUTE);
            mic.setBackground(round(CARD, dp(14), LINE));
            return;
        }
        int bars = Math.min(5, Math.round(WatchService.micLevel * 12));
        mic.setText("🎙 " + "▮▮▮▮▮".substring(0, bars) + "▯▯▯▯▯".substring(bars));
        mic.setTextColor(INK);
        mic.setBackground(round(LIVE, dp(14), 0));
    }

    private void styleTab(TextView t, boolean on) {
        t.setTextColor(on ? INK : MUTE);
        t.setBackground(on ? round(CARD2, dp(9), 0) : null);
    }

    // ---------------------------------------------------------------- lifecycle and service
    @Override
    protected void onResume() {
        super.onResume();
        WatchService.listener = this;
        onStatus(WatchService.status);
        if (WatchService.lastState != null) onState(WatchService.lastState);
        transcript.removeAllViews();
        synchronized (WatchService.recent) {
            for (JSONObject l : WatchService.recent) addFinal(l);
        }
        scrollDown();
        if (!WatchService.running) start(savedHost());   // connect on open; Disconnect (behind the gear) stops
    }

    @Override
    protected void onPause() {
        WatchService.listener = null;
        super.onPause();
    }

    private String savedHost() {
        return getSharedPreferences("tvwatch", MODE_PRIVATE).getString("host", "");
    }

    private void start(String h) {
        Intent i = new Intent(this, WatchService.class);
        if (h != null && !h.isEmpty()) i.putExtra(WatchService.EXTRA_HOST, h.contains(":") ? h : h + ":" + Finder.PORT);
        startForegroundService(i);
    }

    private void stop() {
        startService(new Intent(this, WatchService.class).setAction(WatchService.ACTION_STOP));
    }

    /** the gear: the Pi's address, connect / disconnect, a test alert */
    private void settings() {
        LinearLayout box = column();
        box.setPadding(dp(22), dp(8), dp(22), 0);
        box.addView(text(WatchService.status, 14, MUTE));
        EditText host = new EditText(this);
        host.setHint("blank = find it on this Wi-Fi");
        host.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        host.setSingleLine(true);
        host.setText(WatchService.host != null ? WatchService.host : savedHost());
        box.addView(host);
        if (WatchService.host != null) {   // TV mode: the same feed as big captions + a score bug, for the TV itself
            String tv = "http://" + WatchService.host + "/tv";
            TextView link = text("📺 TV mode: " + tv + "\nOpen it in the TV's browser (or cast a Chrome tab).", 13, ACCENT);
            link.setPadding(0, dp(10), 0, dp(4));
            link.setOnClickListener(v -> startActivity(new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(tv))));
            box.addView(link);
        }
        new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                .setTitle("Raspberry Pi")
                .setView(box)
                .setPositiveButton(WatchService.running ? "Reconnect" : "Connect", (x, y) -> {
                    String h = host.getText().toString().trim();
                    if (WatchService.running) stop();
                    if (h.isEmpty()) getSharedPreferences("tvwatch", MODE_PRIVATE).edit().remove("host").apply();
                    statusText.postDelayed(() -> start(h), 400);
                })
                .setNeutralButton("Test alert", (x, y) -> {
                    String h = WatchService.host;
                    if (h != null) new Thread(() -> Finder.post(h, "/api/test")).start();
                })
                .setNegativeButton(WatchService.running ? "Disconnect" : "Close", (x, y) -> {
                    if (WatchService.running) stop();
                })
                .show();
    }

    @Override
    public void onStatus(String s) {
        runOnUiThread(() -> {
            boolean up = s.startsWith("Connected");
            boolean trying = !up && WatchService.running;
            statusText.setText(up ? "Live" : trying ? "Connecting" : "Offline");
            int c = up ? OK : trying ? GOLD : MUTE;
            statusText.setTextColor(c);
            statusDot.setTextColor(c);
            livePill.setVisibility(up ? View.VISIBLE : View.INVISIBLE);
            if (up) pulse(livePill);
            if (!up && transcript.getChildCount() == 0)
                partial.setText(trying ? s : "Not connected. Tap ⚙ to connect to the Pi.");
        });
    }

    @Override
    public void onState(JSONObject o) {
        runOnUiThread(() -> {
            String d = o.optString("domain");
            if (!d.isEmpty() && !d.equals(domain)) {   // switched elsewhere (another phone, the web page): a new game
                if (!domain.isEmpty()) {
                    transcript.removeAllViews();
                    partial.setText("Listening for " + (sports != null ? sports.optString(d, d) : d) + "…");
                    synchronized (WatchService.recent) {
                        WatchService.recent.clear();
                    }
                }
                domain = d;
                drawSports();
            }
            JSONArray s = o.optJSONArray("score");
            String st = o.isNull("score_text") ? "" : o.optString("score_text");   // the Pi formats it per sport (cricket 142/6)
            score.setText(!st.isEmpty() ? st : s != null && s.length() == 2 ? s.optInt(0) + " – " + s.optInt(1) : "– : –");
            String label = o.isNull("clock_label") ? "" : o.optString("clock_label");
            if (!label.isEmpty()) clock.setText(label);
            else if (o.isNull("clock")) clock.setText("–");
            else clock.setText(String.format("%d:%02d", o.optInt("clock") / 60, o.optInt("clock") % 60));
            clockLabel.setText(domain.equals("soccer") ? "MINUTE" : domain.equals("cricket") ? "OVERS" : "CLOCK");
        });
    }

    @Override
    public void onHello(JSONObject h) {
        runOnUiThread(() -> {
            if (h.optJSONObject("sports") != null) {
                sports = h.optJSONObject("sports");
                domain = h.optString("domain");
                drawSports();
            }
            transcript.removeAllViews();
            JSONArray lines = h.optJSONArray("lines");
            for (int i = 0; lines != null && i < lines.length(); i++) addFinal(lines.optJSONObject(i));
            partial.setText(lines != null && lines.length() > 0 ? "" : "Listening…");
            JSONArray al = h.optJSONArray("alerts");
            if (alertList.getChildCount() == 0)
                for (int i = 0; al != null && i < al.length(); i++) addAlert(al.optJSONObject(i));
            scrollDown();
        });
    }

    @Override
    public void onLine(String kind, JSONObject line) {
        runOnUiThread(() -> {
            boolean atBottom = isAtBottom();
            if (kind.equals("partial")) {
                SpannableStringBuilder t = new SpannableStringBuilder(Highlight.of(line, MUTE));
                t.append(" ▍");
                partial.setText(t);
                partial.setTextColor(0xFFB5BCCC);
            } else {
                addFinal(line);
                partial.setText("");
            }
            if (atBottom) scrollDown();
        });
    }

    private void addFinal(JSONObject line) {
        TextView t = text("", 17, INK);
        t.setText(Highlight.of(line, INK, this::watchName));
        t.setMovementMethod(android.text.method.LinkMovementMethod.getInstance());
        t.setHighlightColor(0x00000000);
        t.setLineSpacing(dp(3), 1f);
        t.setPadding(0, dp(8), 0, dp(4));
        transcript.addView(t);
        while (transcript.getChildCount() > 40) transcript.removeViewAt(0);
    }

    /** a tapped name in the transcript: offer an alert whenever it comes up again */
    private void watchName(String name, String tag) {
        String h = WatchService.host;
        if (h == null) return;
        String kind = tag.equals("ENTITY_PERSON") ? "person" : tag.equals("ENTITY_TEAM") ? "team" : "name";
        new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                .setTitle("Watch " + name + "?")
                .setMessage("You'll get an alert whenever the TV mentions this " + kind + ".")
                .setPositiveButton("Alert me", (x, y) -> new Thread(() -> {
                    try {
                        JSONObject r = new JSONObject().put("type", "name").put("name", name).put("cooldown_s", 120)
                                .put("id", "tap-" + name.toLowerCase().replaceAll("[^a-z0-9]+", "-"));
                        Finder.post(h, "/api/rules", r.toString());
                        runOnUiThread(() -> android.widget.Toast.makeText(this, "Watching " + name,
                                android.widget.Toast.LENGTH_SHORT).show());
                    } catch (Exception ignored) {
                    }
                }).start())
                .setNegativeButton("Cancel", null)
                .show();
    }

    private boolean isAtBottom() {
        View c = liveScroll.getChildAt(0);
        return c == null || c.getBottom() - (liveScroll.getHeight() + liveScroll.getScrollY()) < dp(80);
    }

    private void scrollDown() {
        liveScroll.post(() -> liveScroll.smoothScrollTo(0, liveScroll.getChildAt(0).getBottom()));
    }

    @Override
    public void onAlertUpdate(JSONObject u) {
        runOnUiThread(() -> {
            TextView[] v = alertViews.get(u.optInt("aid"));
            if (v != null) {
                v[0].setText(u.optString("title"));
                v[1].setText(u.optString("body"));
            }
        });
    }

    @Override
    public void onHealth(JSONObject h) {
        runOnUiThread(() -> {
            double t = h.optDouble("temp", Double.NaN);
            boolean hot = !Double.isNaN(t) && (t >= 80 || h.optBoolean("throttled"));
            heat.setVisibility(hot ? View.VISIBLE : View.GONE);
            if (hot) {
                heat.setText("🌡 " + Math.round(t) + "°");
                heat.setTextColor(t >= 84 ? LIVE : GOLD);
                heat.setBackground(round(CARD, dp(16), t >= 84 ? LIVE : GOLD));
            }
            double lvl = h.optDouble("level", 0);
            View p = (View) levelBar.getParent();
            int w = (int) Math.min(p.getWidth(), p.getWidth() * Math.min(1.0, lvl * 1.6));
            levelBar.getLayoutParams().width = w;
            levelBar.setBackgroundColor(lvl > 0.95 ? LIVE : lvl < 0.02 ? MUTE : OK);
            levelBar.requestLayout();
        });
    }

    @Override
    public void onSound(JSONObject e) {
        runOnUiThread(() -> {
            sound.setText("🔊 " + e.optString("label").replaceFirst("^(scene|meta)\\.", "").replace('.', ' '));
            sound.removeCallbacks(clearSound);
            sound.postDelayed(clearSound, 6000);
        });
    }

    private final Runnable clearSound = () -> sound.setText("");

    @Override
    public void onAlert(JSONObject a) {
        runOnUiThread(() -> {
            addAlert(a);
            if (!onAlertsTab) {
                alertCount++;
                tabAlerts.setText("Alerts  " + alertCount);
                banner.setText(a.optString("title") + "  ·  " + a.optString("body"));
                banner.setVisibility(View.VISIBLE);
                banner.setAlpha(0f);
                banner.setTranslationY(-dp(12));
                banner.animate().alpha(1f).translationY(0).setDuration(220).start();
                banner.removeCallbacks(hideBanner);
                banner.postDelayed(hideBanner, 4500);
            }
        });
    }

    private final Runnable hideBanner = () -> banner.animate().alpha(0f).setDuration(300)
            .withEndAction(() -> banner.setVisibility(View.GONE)).start();

    private void addAlert(JSONObject a) {
        emptyAlerts.setVisibility(View.GONE);
        LinearLayout item = new LinearLayout(this);
        View bar = new View(this);
        bar.setBackgroundColor(a.optInt("priority", 4) >= 5 ? LIVE : ACCENT);
        item.addView(bar, new LinearLayout.LayoutParams(dp(4), -1));
        LinearLayout col = column();
        col.setPadding(dp(12), dp(10), dp(12), dp(10));
        LinearLayout top = new LinearLayout(this);
        TextView t = text(a.optString("title"), 16, INK);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        top.addView(t, new LinearLayout.LayoutParams(0, -2, 1));
        top.addView(text(a.optString("time"), 12, MUTE));
        col.addView(top);
        TextView body = text(a.optString("body"), 14, 0xFFC4CAD8);
        body.setPadding(0, dp(3), 0, 0);
        col.addView(body);
        if (a.has("aid")) alertViews.put(a.optInt("aid"), new TextView[]{t, body});
        item.addView(col, new LinearLayout.LayoutParams(0, -2, 1));
        item.setBackground(round(CARD2, dp(12), 0));
        item.setClipToOutline(true);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.setMargins(0, 0, 0, dp(8));
        alertList.addView(item, 0, lp);
        if (alertList.getChildCount() > 40) alertList.removeViewAt(40);
    }

    // ---------------------------------------------------------------- sports
    /** one chip per sport the Pi offers; the chosen one is filled. Tapping switches Arc's domain and rule set. */
    private void drawSports() {
        sportRow.removeAllViews();
        sportLabel.setText(sports != null && !domain.isEmpty()
                ? emoji(domain) + "  " + sports.optString(domain, domain).toUpperCase() : "—");
        if (sports == null) return;
        for (Iterator<String> it = sports.keys(); it.hasNext(); ) {
            String key = it.next();
            boolean on = key.equals(domain);
            TextView c = text(emoji(key) + "  " + shortName(key), 14, on ? INK : 0xFFC4CAD8);
            c.setGravity(Gravity.CENTER);
            c.setPadding(dp(14), 0, dp(14), 0);
            c.setTypeface(on ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
            c.setBackground(on ? round(ACCENT, dp(18), 0) : round(CARD, dp(18), LINE));
            c.setOnClickListener(v -> pickSport(key));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, dp(36));
            lp.setMargins(0, 0, dp(8), 0);
            sportRow.addView(c, lp);
            if (on) c.post(() -> sportScroll.smoothScrollTo(Math.max(0, c.getLeft() - dp(40)), 0));
        }
    }

    private void pickSport(String key) {
        String h = WatchService.host;
        if (h == null || key.equals(domain)) return;
        domain = key;
        drawSports();
        transcript.removeAllViews();
        partial.setText("Listening for " + sports.optString(key) + "…");
        score.setText("– : –");
        clock.setText("–");
        clockLabel.setText(key.equals("soccer") ? "MINUTE" : "CLOCK");
        WatchService.lastState = null;
        synchronized (WatchService.recent) {
            WatchService.recent.clear();
        }
        new Thread(() -> Finder.post(h, "/api/sport", "{\"domain\":\"" + key + "\"}")).start();
    }

    private static String shortName(String d) {
        switch (d) {
            case "nba": return "NBA";
            case "nfl": return "NFL";
            case "nhl": return "NHL";
            case "soccer": return "Soccer";
            case "cricket": return "Cricket";
            case "esports": return "Esports";
            case "news": return "News";
            case "court_trial": return "Court";
            case "stream_chat": return "Streams";
            default: return "Talk";
        }
    }

    static String emoji(String d) {
        switch (d) {
            case "nba": return "🏀";
            case "nfl": return "🏈";
            case "nhl": return "🏒";
            case "soccer": return "⚽";
            case "cricket": return "🏏";
            case "esports": return "🎮";
            case "news": return "📰";
            case "court_trial": return "⚖️";
            case "stream_chat": return "📡";
            default: return "🎙️";
        }
    }

    /** a row of the highlight colours, so the audience can read the transcript */
    private View legend() {
        TextView t = text("", 11, MUTE);
        SpannableStringBuilder b = new SpannableStringBuilder();
        String[][] items = {{"person", "ENTITY_PERSON"}, {"team", "ENTITY_TEAM"}, {"place", "ENTITY_PLACE"},
                {"number", "NUMBER_SCORE"}, {"★ watch", "WATCH"}};
        for (String[] it : items) {
            int st = b.length();
            b.append(" ").append(it[0]).append(" ");
            Highlight.style(b, st, b.length(), it[1], it[1].equals("WATCH"));
            b.append(" ");
        }
        t.setText(b);
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        return t;
    }

    // ---------------------------------------------------------------- small view helpers
    private static void pulse(View v) {
        if (v.getTag() != null) return;
        ObjectAnimator a = ObjectAnimator.ofFloat(v, "alpha", 1f, 0.45f);
        a.setDuration(900);
        a.setRepeatMode(ValueAnimator.REVERSE);
        a.setRepeatCount(ValueAnimator.INFINITE);
        a.start();
        v.setTag(a);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private LinearLayout column() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        return l;
    }

    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        return t;
    }

    private TextView tab(String s) {
        TextView t = text(s, 14, MUTE);
        t.setGravity(Gravity.CENTER);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private GradientDrawable round(int color, int radius, int stroke) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(color);
        g.setCornerRadius(radius);
        if (stroke != 0) g.setStroke(dp(1), stroke);
        return g;
    }
}
