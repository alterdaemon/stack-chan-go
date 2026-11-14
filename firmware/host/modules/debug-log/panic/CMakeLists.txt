idf_component_register(SRCS "panic.c" REQUIRES esp_system)
target_link_libraries(${COMPONENT_LIB} INTERFACE "-Wl,--wrap=esp_panic_handler")
