package ai.whissle.tvwatch;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Finds the Pi running tvwatch.py: the last address, whissle-pi.local, then every host on this phone's Wi-Fi or
 *  hotspot subnets (a /24 each) answering /api/state on port 8080. No mDNS needed, so it works on a phone hotspot. */
final class Finder {
    static final int PORT = 8080;

    private Finder() {}

    /** host:port answering as TV Watch, or null. Blocking: call off the main thread. */
    static String find(String preferred) {
        if (preferred != null && !preferred.isEmpty() && isTvWatch(preferred, 1500)) return preferred;
        if (isTvWatch("whissle-pi.local:" + PORT, 1500)) return "whissle-pi.local:" + PORT;
        return scan();
    }

    /** every host on this device's private IPv4 subnets (a /24 each) */
    static String scan() {
        List<String> prefixes = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && a.isSiteLocalAddress()) {
                        String ip = a.getHostAddress();
                        String p = ip.substring(0, ip.lastIndexOf('.') + 1);
                        if (!prefixes.contains(p)) prefixes.add(p);
                    }
                }
            }
        } catch (Exception ignored) {
        }
        AtomicReference<String> hit = new AtomicReference<>();
        ExecutorService pool = Executors.newFixedThreadPool(64);
        for (String p : prefixes)
            for (int i = 1; i < 255; i++) {
                String host = p + i + ":" + PORT;
                pool.execute(() -> {
                    if (hit.get() == null && isTvWatch(host, 700)) hit.compareAndSet(null, host);
                });
            }
        pool.shutdown();
        try {
            pool.awaitTermination(20, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
        }
        pool.shutdownNow();
        return hit.get();
    }

    static boolean isTvWatch(String host, int timeoutMs) {
        String body = get(host, "/api/state", timeoutMs);
        return body != null && body.contains("\"domain\"") && body.contains("\"rules\"");
    }

    static String get(String host, String path, int timeoutMs) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL("http://" + host + path).openConnection();
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs * 2);
            if (c.getResponseCode() != 200) return null;
            InputStream in = c.getInputStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] b = new byte[8192];
            for (int n; (n = in.read(b)) > 0; ) out.write(b, 0, n);
            return out.toString("UTF-8");
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    static void post(String host, String path) {
        post(host, path, "{}");
    }

    static void post(String host, String path, String json) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL("http://" + host + path).openConnection();
            c.setConnectTimeout(2000);
            c.setReadTimeout(4000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.getOutputStream().write(json.getBytes("UTF-8"));
            c.getResponseCode();
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
