package com.monika.dashboard.lsposed;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;

import io.github.libxposed.api.XposedInterface;

final class LspHookSupport {
    interface AfterHook {
        void after(XposedInterface.Chain chain) throws Throwable;
    }

    interface ResultAfterHook {
        void after(XposedInterface.Chain chain, Object result) throws Throwable;
    }

    interface MethodFinder {
        Method find(Class<?> clazz);
    }

    private static final Object MISS = new Object();
    private static final String NO_ARG_SIG = "#";

    private final XposedInterface xposed;
    private final ConcurrentHashMap<String, Object> classCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Object> methodCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Object> fieldCache = new ConcurrentHashMap<>();

    LspHookSupport(XposedInterface xposed) {
        this.xposed = xposed;
    }

    Class<?> findClass(String name) {
        return findClass(name, null);
    }

    Class<?> findClass(String name, ClassLoader loader) {
        String cacheKey = name + "@" + (loader != null ? System.identityHashCode(loader) : 0);
        Object cached = classCache.get(cacheKey);
        if (cached instanceof Class<?>) return (Class<?>) cached;
        if (cached == MISS) return null;
        try {
            Class<?> clazz = loader != null ? Class.forName(name, false, loader) : Class.forName(name);
            classCache.put(cacheKey, clazz);
            return clazz;
        } catch (Throwable ignored) {
            classCache.put(cacheKey, MISS);
            return null;
        }
    }

    Method declaredMethodByName(Class<?> clazz, String name) {
        if (clazz == null) return null;
        String cacheKey = methodCacheKey(clazz, "byName:" + name, NO_ARG_SIG);
        Object cached = methodCache.get(cacheKey);
        if (cached instanceof Method) return (Method) cached;
        if (cached == MISS) return null;
        for (Method method : clazz.getDeclaredMethods()) {
            if (name.equals(method.getName())) {
                try { method.setAccessible(true); } catch (Throwable ignored) {}
                methodCache.put(cacheKey, method);
                return method;
            }
        }
        methodCache.put(cacheKey, MISS);
        return null;
    }

    @SuppressWarnings("unchecked")
    List<Method> declaredMethodsByName(Class<?> clazz, String... names) {
        if (clazz == null || names == null || names.length == 0) return Collections.emptyList();
        String cacheKey = methodCacheKey(clazz, "methodsByName:" + namesKey(names), NO_ARG_SIG);
        Object cached = methodCache.get(cacheKey);
        if (cached instanceof List<?>) return (List<Method>) cached;
        if (cached == MISS) return Collections.emptyList();

        ArrayList<Method> methods = new ArrayList<>();
        for (Method method : clazz.getDeclaredMethods()) {
            if (!matchesName(method.getName(), names)) continue;
            try { method.setAccessible(true); } catch (Throwable ignored) {}
            methods.add(method);
        }
        if (methods.isEmpty()) {
            methodCache.put(cacheKey, MISS);
            return Collections.emptyList();
        }
        List<Method> result = Collections.unmodifiableList(methods);
        methodCache.put(cacheKey, result);
        return result;
    }

    Method declaredMethod(Class<?> clazz, String name, Class<?>... paramTypes) {
        if (clazz == null) return null;
        String cacheKey = methodCacheKey(clazz, name, signatureKey(paramTypes));
        Object cached = methodCache.get(cacheKey);
        if (cached instanceof Method) return (Method) cached;
        if (cached == MISS) return null;
        try {
            Method method = clazz.getDeclaredMethod(name, paramTypes);
            try { method.setAccessible(true); } catch (Throwable ignored) {}
            methodCache.put(cacheKey, method);
            return method;
        } catch (Throwable ignored) {
            methodCache.put(cacheKey, MISS);
            return null;
        }
    }

    Method publicMethod(Class<?> clazz, String name, Class<?>... paramTypes) {
        if (clazz == null) return null;
        String cacheKey = methodCacheKey(clazz, "public:" + name, signatureKey(paramTypes));
        Object cached = methodCache.get(cacheKey);
        if (cached instanceof Method) return (Method) cached;
        if (cached == MISS) return null;
        try {
            Method method = clazz.getMethod(name, paramTypes);
            try { method.setAccessible(true); } catch (Throwable ignored) {}
            methodCache.put(cacheKey, method);
            return method;
        } catch (Throwable ignored) {
            methodCache.put(cacheKey, MISS);
            return null;
        }
    }

    Method declaredMethodInHierarchy(Class<?> clazz, String name) {
        if (clazz == null) return null;
        return cachedMethod(clazz, "hierarchy:" + name, target -> {
            Class<?> current = target;
            while (current != null) {
                try {
                    Method method = current.getDeclaredMethod(name);
                    try { method.setAccessible(true); } catch (Throwable ignored) {}
                    return method;
                } catch (Throwable ignored) {
                    current = current.getSuperclass();
                }
            }
            return null;
        });
    }

    Object invokeNoArg(Object target, String methodName) {
        if (target == null) return null;
        boolean staticTarget = target instanceof Class<?>;
        Class<?> clazz = staticTarget ? (Class<?>) target : target.getClass();
        Method method = declaredMethodInHierarchy(clazz, methodName);
        if (method == null) return null;
        try {
            return method.invoke(staticTarget ? null : target);
        } catch (Throwable ignored) {
            return null;
        }
    }

    Object invokeFirstNoArg(Object target, String... methodNames) {
        if (target == null || methodNames == null) return null;
        for (String methodName : methodNames) {
            if (methodName == null || methodName.length() == 0) continue;
            Object value = invokeNoArg(target, methodName);
            if (value != null) return value;
        }
        return null;
    }

    Object readField(Object target, String fieldName) {
        if (target == null) return null;
        Field field = fieldInHierarchy(target.getClass(), fieldName);
        if (field == null) return null;
        try {
            return field.get(target);
        } catch (Throwable ignored) {
            return null;
        }
    }

    Object readFirstField(Object target, String... fieldNames) {
        if (target == null || fieldNames == null) return null;
        for (String fieldName : fieldNames) {
            if (fieldName == null || fieldName.length() == 0) continue;
            Object value = readField(target, fieldName);
            if (value != null) return value;
        }
        return null;
    }

    Object readStaticField(Class<?> clazz, String fieldName) {
        Field field = fieldInHierarchy(clazz, fieldName);
        if (field == null) return null;
        try {
            return field.get(null);
        } catch (Throwable ignored) {
            return null;
        }
    }

    Method cachedMethod(Class<?> clazz, String purpose, MethodFinder finder) {
        if (clazz == null || finder == null) return null;
        String cacheKey = methodCacheKey(clazz, purpose, NO_ARG_SIG);
        Object cached = methodCache.get(cacheKey);
        if (cached instanceof Method) return (Method) cached;
        if (cached == MISS) return null;
        Method method;
        try {
            method = finder.find(clazz);
        } catch (Throwable ignored) {
            method = null;
        }
        if (method != null) {
            try { method.setAccessible(true); } catch (Throwable ignored) {}
            methodCache.put(cacheKey, method);
            return method;
        }
        methodCache.put(cacheKey, MISS);
        return null;
    }

    boolean hookAfter(Method method, AfterHook afterHook) {
        return hookAfterResult(method, (chain, result) -> afterHook.after(chain));
    }

    boolean hookAfterResult(Method method, ResultAfterHook afterHook) {
        if (method == null) return false;
        try { xposed.deoptimize(method); } catch (Throwable ignored) {}
        try {
            xposed.hook(method)
                    .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                    .intercept(chain -> {
                        Object result = chain.proceed();
                        try {
                            afterHook.after(chain, result);
                        } catch (Throwable ignored) {}
                        return result;
                    });
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private Field fieldInHierarchy(Class<?> clazz, String fieldName) {
        if (clazz == null || fieldName == null) return null;
        String cacheKey = fieldCacheKey(clazz, fieldName);
        Object cached = fieldCache.get(cacheKey);
        if (cached instanceof Field) return (Field) cached;
        if (cached == MISS) return null;

        Class<?> current = clazz;
        while (current != null) {
            try {
                Field field = current.getDeclaredField(fieldName);
                try { field.setAccessible(true); } catch (Throwable ignored) {}
                fieldCache.put(cacheKey, field);
                return field;
            } catch (Throwable ignored) {
                current = current.getSuperclass();
            }
        }
        fieldCache.put(cacheKey, MISS);
        return null;
    }

    String signatureKey(Class<?>... paramTypes) {
        if (paramTypes == null || paramTypes.length == 0) return NO_ARG_SIG;
        StringBuilder sb = new StringBuilder();
        for (Class<?> param : paramTypes) {
            if (sb.length() > 0) sb.append(',');
            sb.append(param != null ? param.getName() : "null");
        }
        return sb.toString();
    }

    private String methodCacheKey(Class<?> clazz, String name, String signature) {
        return System.identityHashCode(clazz) + ":" + clazz.getName() + "#" + name + signature;
    }

    private String fieldCacheKey(Class<?> clazz, String fieldName) {
        return System.identityHashCode(clazz) + ":" + clazz.getName() + "#" + fieldName;
    }

    private boolean matchesName(String value, String... names) {
        if (value == null || names == null) return false;
        for (String name : names) {
            if (value.equals(name)) return true;
        }
        return false;
    }

    private String namesKey(String... names) {
        StringBuilder sb = new StringBuilder();
        for (String name : names) {
            if (sb.length() > 0) sb.append(',');
            sb.append(name != null ? name : "null");
        }
        return sb.toString();
    }
}
