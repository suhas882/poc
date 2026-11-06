# Release builds drop debug, verbose and info logging entirely. The app never logs message content in any build.
-assumenosideeffects class android.util.Log {
    public static int v(...);
    public static int d(...);
    public static int i(...);
}
