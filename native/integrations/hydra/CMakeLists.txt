cmake_minimum_required(VERSION 3.26)
project(hdMuTracer LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
find_package(OpenGL REQUIRED)
set(MUTRACER_BLENDER_ROOT "" CACHE PATH "Blender 5.2 application bundle (macOS)")
if(MUTRACER_BLENDER_ROOT)
  # Do not import the matching development build's USD targets: their transitive
  # dependencies would load a second USD/Python/TBB into Blender's process.
  find_path(MUTRACER_USD_INCLUDE_DIR pxr/pxr.h
    HINTS ${CMAKE_PREFIX_PATH} PATH_SUFFIXES include REQUIRED)
  find_path(MUTRACER_TBB_INCLUDE_DIR tbb/tbb.h
    HINTS ${CMAKE_PREFIX_PATH} PATH_SUFFIXES include REQUIRED)
  file(READ "${MUTRACER_USD_INCLUDE_DIR}/pxr/pxr.h" usd_header)
  if(NOT usd_header MATCHES "#define PXR_INTERNAL_NS pxrBlender_v26_03__pxrReserved__"
      OR NOT usd_header MATCHES "#define PXR_VERSION 2603"
      OR NOT usd_header MATCHES "#define PXR_PYTHON_SUPPORT_ENABLED")
    message(FATAL_ERROR "Blender needs Python-enabled USD 26.03 headers with pxrBlender_v26_03 namespace")
  endif()
  file(READ "${MUTRACER_USD_INCLUDE_DIR}/pxr/base/arch/attributes.h" arch_header)
  if(NOT arch_header MATCHES "__DATA,pxbctor")
    message(FATAL_ERROR "Blender's USD headers must use its pxbctor/pxbdtor registration sections")
  endif()
  set(blender_lib "${MUTRACER_BLENDER_ROOT}/Contents/Resources/lib")
  find_path(MUTRACER_PYTHON_INCLUDE_DIR Python.h
    HINTS ${CMAKE_PREFIX_PATH} PATH_SUFFIXES include/python3.13 REQUIRED)
  set(blender_python "${MUTRACER_PYTHON_INCLUDE_DIR}")
  if(NOT EXISTS "${blender_lib}/libusd_ms.dylib" OR NOT EXISTS "${blender_python}/Python.h")
    message(FATAL_ERROR "Expected a Blender 5.2 macOS bundle with USD and Python 3.13 headers")
  endif()
  set(PXR_INCLUDE_DIRS "${MUTRACER_USD_INCLUDE_DIR}" "${MUTRACER_TBB_INCLUDE_DIR}" "${blender_python}")
  set(mutracer_usd_libraries "${blender_lib}/libusd_ms.dylib" "${blender_lib}/libtbb.dylib")
else()
  find_package(pxr CONFIG REQUIRED)
  set(mutracer_usd_libraries hd hdx hgi hgiMetal usdImagingGL usdImaging usdLux usdShade usdGeom usd sdf sdr js tf gf vt hio hf cameraUtil)
endif()
get_filename_component(MUTRACER_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../.." ABSOLUTE)
set(MUTRACER_LIBRARY_DIR "${MUTRACER_ROOT}/.native-build/scene-core/cargo-target/release" CACHE PATH "Built SDK directory")
find_library(MUTRACER_LIBRARY mutracer_native_probe PATHS "${MUTRACER_LIBRARY_DIR}" NO_DEFAULT_PATH REQUIRED)
enable_language(OBJCXX)
add_library(hdMuTracer SHARED delegate.cpp scene.cpp material.cpp materialGraph.cpp gpu.cpp gpuMetal.mm)
set_source_files_properties(gpuMetal.mm PROPERTIES COMPILE_FLAGS "-fobjc-arc")
target_include_directories(hdMuTracer PUBLIC ${PXR_INCLUDE_DIRS} "${MUTRACER_ROOT}/native/include" "${CMAKE_CURRENT_SOURCE_DIR}")
target_link_libraries(hdMuTracer PUBLIC ${mutracer_usd_libraries} "${MUTRACER_LIBRARY}" "-framework Metal" "-framework Foundation")
set_target_properties(hdMuTracer PROPERTIES LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/plugin/hdMuTracer" BUILD_RPATH "${MUTRACER_LIBRARY_DIR};${PXR_LIBRARY_DIRS}" INSTALL_RPATH "${MUTRACER_LIBRARY_DIR};${PXR_LIBRARY_DIRS}")
configure_file(resources/plugInfo.json.in "${CMAKE_CURRENT_BINARY_DIR}/plugin/hdMuTracer/resources/plugInfo.json" @ONLY)
if(MUTRACER_BLENDER_ROOT)
  # VtValue's inline converters reference Blender's statically linked Python.
  # Keep USD symbols link-checked; only these interpreter symbols are deferred.
  foreach(symbol _PyBool_FromLong _PyFloat_FromDouble _PyLong_FromLong
      _PyUnicode_FromStringAndSize __Py_Dealloc __Py_NoneStruct)
    target_link_options(hdMuTracer PRIVATE "LINKER:-U,${symbol}")
  endforeach()
  set_target_properties(hdMuTracer PROPERTIES
    BUILD_WITH_INSTALL_RPATH ON
    INSTALL_RPATH "@loader_path;@executable_path/../Resources/lib")
  get_filename_component(mutracer_library_name "${MUTRACER_LIBRARY}" NAME)
  add_custom_command(TARGET hdMuTracer POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${MUTRACER_LIBRARY}"
      "$<TARGET_FILE_DIR:hdMuTracer>/${mutracer_library_name}")
  install(TARGETS hdMuTracer LIBRARY DESTINATION hdMuTracer)
  install(FILES "${MUTRACER_LIBRARY}" DESTINATION hdMuTracer)
  install(FILES "${CMAKE_CURRENT_BINARY_DIR}/plugin/hdMuTracer/resources/plugInfo.json"
    DESTINATION hdMuTracer/resources)
else()
  enable_testing()
  add_executable(hydraContracts tests/contracts.cpp)
  target_link_libraries(hydraContracts PRIVATE hdMuTracer)
  target_compile_definitions(hydraContracts PRIVATE MT_TEST_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/tests")
  add_test(NAME hydraContracts COMMAND hydraContracts)
  add_executable(hydraTrace tests/trace.cpp tests/slowHost.mm)
  set_source_files_properties(tests/slowHost.mm PROPERTIES COMPILE_FLAGS "-fobjc-arc")
  target_link_libraries(hydraTrace PRIVATE hdMuTracer)
  add_executable(hydraGpuContracts tests/conversion.cpp)
  target_link_libraries(hydraGpuContracts PRIVATE hdMuTracer)
  add_test(NAME hydraGpuContracts COMMAND hydraGpuContracts)
endif()
