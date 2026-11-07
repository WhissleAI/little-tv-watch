package ai.whissle.tvwatch;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/** Stays connected to the Pi's event stream (/api/events, server-sent events) and turns each alert into a
 *  heads-up notification. Reconnects on its own; after repeated failures it looks for the Pi again (Finder). */
public class WatchService extends Service {
    static final String ACTION_STOP = "ai.whissle.tvwatch.STOP";
    static final String ACTION_MIC_ON = "ai.whissle.tvwatch.MIC_ON", ACTION_MIC_OFF = "ai.whissle.tvwatch.MIC_OFF";
    /** the phone as the TV's microphone: its audio streams to the Pi (/api/audio), which hears it instead of its own */
    static volatile boolean micOn;
    static volatile float micLevel;
    private volatile Thread micThread;
    static final String EXTRA_HOST = "host";
    private static final String CH_ALERTS = "alerts", CH_LISTEN = "listening";
    private static final int ID_LISTEN = 1;

    interface Listener {
        void onStatus(String status);
        void onState(JSONObject state);
        void onAlert(JSONObject alert);
        void onLine(String kind, JSONObject line);   // "partial" (live, replaces the last partial) / "final"
        void onSound(JSONObject event);
        void onHello(JSONObject hello);              // on (re)connect: recent lines and alerts
        void onHealth(JSONObject health);            // every 2 s: Pi temperature, input level
        void onAlertUpdate(JSONObject update);       // an early alert's clean text, once its sentence is final
    }

    static volatile Listener listener;
    static volatile String status = "Not connected";
    static volatile JSONObject lastState;
    static volatile boolean running;
    static volatile String host;
    /** the last final lines, for a screen that opens mid-stream */
    static final java.util.ArrayDeque<JSONObject> recent = new java.util.ArrayDeque<>();

    private static void remember(JSONObject line) {
        synchronized (recent) {
            recent.addLast(line);
            while (recent.size() > 12) recent.removeFirst();
        }
    }

    private volatile Thread worker;
    private volatile HttpURLConnection conn;
    private int nextId = 100;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (intent != null && intent.getStringExtra(EXTRA_HOST) != null) host = intent.getStringExtra(EXTRA_HOST);
        channels();
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_MIC_ON.equals(action)) micOn = true;
        if (ACTION_MIC_OFF.equals(action)) micOn = false;
        Notification n = listening(micOn ? "Phone mic → Pi" : status);
        if (Build.VERSION.SDK_INT >= 30)
            startForeground(ID_LISTEN, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                    | (micOn ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0));
        else startForeground(ID_LISTEN, n);
        if (micOn && micThread == null) {
            micThread = new Thread(this::micLoop, "tvwatch-mic");
            micThread.start();
        }
        running = true;
        if (worker == null) {
            worker = new Thread(this::loop, "tvwatch-events");
            worker.start();
        }
        return START_STICKY;
    }

    /** 16 kHz mono 16-bit from the microphone, posted to the Pi as one long chunked request (re-opened if it drops) */
    private void micLoop() {
        while (micOn && running) {
            String h = host;
            android.media.AudioRecord rec = null;
            HttpURLConnection c = null;
            try {
                if (h == null) throw new Exception("no Pi yet");
                int min = android.media.AudioRecord.getMinBufferSize(16000, android.media.AudioFormat.CHANNEL_IN_MONO,
                        android.media.AudioFormat.ENCODING_PCM_16BIT);
                rec = new android.media.AudioRecord(android.media.MediaRecorder.AudioSource.VOICE_RECOGNITION, 16000,
                        android.media.AudioFormat.CHANNEL_IN_MONO, android.media.AudioFormat.ENCODING_PCM_16BIT,
                        Math.max(min, 16000));
                c = (HttpURLConnection) new URL("http://" + h + "/api/audio").openConnection();
                c.setDoOutput(true);
                c.setRequestMethod("POST");
                c.setChunkedStreamingMode(3200);
                c.setConnectTimeout(4000);
                c.setRequestProperty("Content-Type", "application/octet-stream");
                c.setRequestProperty("X-Device", Build.MODEL);
                java.io.OutputStream out = c.getOutputStream();
                rec.startRecording();
                short[] pcm = new short[1600];   // 100 ms
                byte[] buf = new byte[3200];
                while (micOn && running) {
                    int n = rec.read(pcm, 0, pcm.length);
                    if (n <= 0) continue;
                    int peak = 0;
                    for (int i = 0; i < n; i++) {
                        buf[2 * i] = (byte) pcm[i];
                        buf[2 * i + 1] = (byte) (pcm[i] >> 8);
                        peak = Math.max(peak, Math.abs(pcm[i]));
                    }
                    micLevel = peak / 32768f;
                    out.write(buf, 0, 2 * n);
                    out.flush();
                }
                out.close();
                c.getResponseCode();
            } catch (Exception e) {
                sleep(1500);
            } finally {
                if (rec != null) {
                    try {
                        rec.stop();
                    } catch (Exception ignored) {
                    }
                    rec.release();
                }
                if (c != null) c.disconnect();
            }
        }
        micLevel = 0;
        micThread = null;
    }

    @Override
    public void onDestroy() {
        micOn = false;
        running = false;
        Thread w = worker;
        worker = null;
        if (w != null) w.interrupt();
        HttpURLConnection c = conn;
        if (c != null) c.disconnect();
        setStatus("Not connected");
        super.onDestroy();
    }

    private void loop() {
        int fails = 0;
        while (running && worker == Thread.currentThread()) {
            if (host == null || fails >= 3) {
                setStatus("Looking for the Pi on this network…");
                String h = Finder.find(host);
                if (h == null) {
                    setStatus("Pi not found — same Wi-Fi / hotspot? Retrying…");
                    if (!sleep(4000)) return;
                    continue;
                }
                host = h;
                getSharedPreferences("tvwatch", MODE_PRIVATE).edit().putString("host", h).apply();
                fails = 0;
            }
            try {
                setStatus("Connecting to " + host + "…");
                stream(host);
                fails = 0;
            } catch (Exception e) {
                fails++;
            }
            if (!running) return;
            setStatus("Lost the Pi, reconnecting…");
            if (!sleep(Math.min(2000L * fails, 6000L))) return;
        }
    }

    /** Reads server-sent events until the connection drops. The Pi pings every 10 s, so 30 s of silence = dead. */
    private void stream(String h) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL("http://" + h + "/api/events").openConnection();
        conn = c;
        c.setConnectTimeout(4000);
        c.setReadTimeout(30000);
        c.setRequestProperty("Accept", "text/event-stream");
        try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"))) {
            setStatus("Connected to " + h);
            String event = "message";
            StringBuilder data = new StringBuilder();
            for (String line; running && (line = r.readLine()) != null; ) {
                if (line.isEmpty()) {
                    if (data.length() > 0) dispatch(event, data.toString());
                    event = "message";
                    data.setLength(0);
                } else if (line.startsWith("event:")) event = line.substring(6).trim();
                else if (line.startsWith("data:")) data.append(line.substring(5).trim());
            }
        } finally {
            c.disconnect();
            conn = null;
        }
    }

    private void dispatch(String event, String data) {
        try {
            JSONObject o = new JSONObject(data);
            if (event.equals("alert")) {
                notifyAlert(o);
                Listener l = listener;
                if (l != null) l.onAlert(o);
            } else if (event.equals("state") || event.equals("hello")) {
                lastState = o;
                Listener l = listener;
                if (l != null) {
                    l.onState(o);
                    if (event.equals("hello")) l.onHello(o);
                }
            } else if (event.equals("partial") || event.equals("final")) {
                if (event.equals("final")) remember(o);
                Listener l = listener;
                if (l != null) l.onLine(event, o);
            } else if (event.equals("alert_update")) {
                Integer nid = notifOf.get(o.optInt("aid"));
                if (nid != null) notifyAlert(o, nid);   // same notification, quietly updated
                Listener l = listener;
                if (l != null) l.onAlertUpdate(o);
            } else if (event.equals("health")) {
                Listener l = listener;
                if (l != null) l.onHealth(o);
            } else if (event.equals("event")) {
                Listener l = listener;
                if (l != null) l.onSound(o);
            }
        } catch (Exception ignored) {
        }
    }

    private final java.util.Map<Integer, Integer> notifOf = new java.util.HashMap<>();   // alert aid -> notification id

    private void notifyAlert(JSONObject a) {
        int id = nextId++;
        if (a.has("aid")) notifOf.put(a.optInt("aid"), id);
        notifyAlert(a, id);
    }

    private void notifyAlert(JSONObject a, int id) {
        boolean update = !a.has("time");
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        String body = a.optString("body");
        Notification n = new Notification.Builder(this, CH_ALERTS)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("📺 " + a.optString("title"))
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_EVENT)
                .setColor(0xFF2F6FE4)
                .setOnlyAlertOnce(update)
                .build();
        nm().notify(id, n);
    }

    private Notification listening(String text) {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CH_LISTEN)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("TV Watch")
                .setContentText(text)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
    }

    private void setStatus(String s) {
        status = s;
        if (running) nm().notify(ID_LISTEN, listening(s));
        Listener l = listener;
        if (l != null) l.onStatus(s);
    }

    private void channels() {
        NotificationChannel alerts = new NotificationChannel(CH_ALERTS, "TV alerts", NotificationManager.IMPORTANCE_HIGH);
        alerts.setDescription("What your rules caught on TV");
        alerts.enableVibration(true);
        NotificationChannel listen = new NotificationChannel(CH_LISTEN, "Connection", NotificationManager.IMPORTANCE_LOW);
        nm().createNotificationChannel(alerts);
        nm().createNotificationChannel(listen);
    }

    private NotificationManager nm() {
        return (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    }

    private static boolean sleep(long ms) {
        try {
            Thread.sleep(ms);
            return true;
        } catch (InterruptedException e) {
            return false;
        }
    }
}
