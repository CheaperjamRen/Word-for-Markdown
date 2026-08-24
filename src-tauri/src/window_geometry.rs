pub(crate) const IDEAL_INNER_LOGICAL: (f64, f64) = (1180.0, 760.0);
#[allow(dead_code)]
pub(crate) const PROVISIONAL_INNER_LOGICAL: (f64, f64) = (800.0, 400.0);
pub(crate) const NOMINAL_MIN_INNER_LOGICAL: (f64, f64) = (640.0, 400.0);
pub(crate) const SAFE_MARGIN_LOGICAL: f64 = 16.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SizePx {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct WorkAreaPx {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct MonitorSnapshot {
    pub work_area: WorkAreaPx,
    pub scale_factor: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FrameDeltaPx {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct StartupWindowPlan {
    pub inner_size: SizePx,
    pub min_inner_size: SizePx,
    pub predicted_outer_size: SizePx,
    pub effective_margin_x: u32,
    pub effective_margin_y: u32,
}

fn rounded_physical(logical: f64, scale_factor: f64) -> Option<u32> {
    let physical = logical * scale_factor;
    if !physical.is_finite() {
        return None;
    }
    let rounded = physical.round();
    if rounded < 1.0 || rounded > f64::from(u32::MAX) {
        return None;
    }
    Some(rounded as u32)
}

fn ceiling_physical(logical: f64, scale_factor: f64) -> Option<u32> {
    let physical = logical * scale_factor;
    if !physical.is_finite() {
        return None;
    }
    let ceiling = physical.ceil();
    if ceiling < 0.0 || ceiling > f64::from(u32::MAX) {
        return None;
    }
    Some(ceiling as u32)
}

fn plan_axis(
    work_axis: u32,
    frame_axis: u32,
    desired_margin: u32,
    ideal_inner: u32,
    nominal_min_inner: u32,
) -> Option<(u32, u32, u32, u32)> {
    if work_axis <= frame_axis {
        return None;
    }

    let space_after_frame = work_axis - frame_axis;
    let effective_margin = desired_margin.min((space_after_frame - 1) / 2);
    let available_inner = u64::from(work_axis)
        .checked_sub(u64::from(effective_margin).checked_mul(2)?)?
        .checked_sub(u64::from(frame_axis))?;
    let available_inner = u32::try_from(available_inner).ok()?;
    let target_inner = ideal_inner.min(available_inner);
    let effective_min = nominal_min_inner.min(target_inner);
    let predicted_outer =
        u32::try_from(u64::from(target_inner).checked_add(u64::from(frame_axis))?).ok()?;

    if available_inner == 0 || target_inner == 0 || effective_min == 0 || predicted_outer == 0 {
        return None;
    }
    Some((
        target_inner,
        effective_min,
        predicted_outer,
        effective_margin,
    ))
}

pub(crate) fn plan_startup_window(
    monitor: MonitorSnapshot,
    frame: FrameDeltaPx,
) -> Option<StartupWindowPlan> {
    if monitor.work_area.width == 0
        || monitor.work_area.height == 0
        || !monitor.scale_factor.is_finite()
        || monitor.scale_factor <= 0.0
    {
        return None;
    }

    let ideal_width = rounded_physical(IDEAL_INNER_LOGICAL.0, monitor.scale_factor)?;
    let ideal_height = rounded_physical(IDEAL_INNER_LOGICAL.1, monitor.scale_factor)?;
    let min_width = rounded_physical(NOMINAL_MIN_INNER_LOGICAL.0, monitor.scale_factor)?;
    let min_height = rounded_physical(NOMINAL_MIN_INNER_LOGICAL.1, monitor.scale_factor)?;
    let desired_margin = ceiling_physical(SAFE_MARGIN_LOGICAL, monitor.scale_factor)?;

    let (inner_width, min_inner_width, outer_width, effective_margin_x) = plan_axis(
        monitor.work_area.width,
        frame.width,
        desired_margin,
        ideal_width,
        min_width,
    )?;
    let (inner_height, min_inner_height, outer_height, effective_margin_y) = plan_axis(
        monitor.work_area.height,
        frame.height,
        desired_margin,
        ideal_height,
        min_height,
    )?;

    Some(StartupWindowPlan {
        inner_size: SizePx {
            width: inner_width,
            height: inner_height,
        },
        min_inner_size: SizePx {
            width: min_inner_width,
            height: min_inner_height,
        },
        predicted_outer_size: SizePx {
            width: outer_width,
            height: outer_height,
        },
        effective_margin_x,
        effective_margin_y,
    })
}

fn position_axis(work_origin: i32, work_axis: u32, actual_outer_axis: u32) -> Option<i32> {
    if actual_outer_axis == 0 || actual_outer_axis > work_axis {
        return None;
    }

    let work_start = i64::from(work_origin);
    let work_end = work_start.checked_add(i64::from(work_axis))?;
    let centered = work_start.checked_add(i64::from(work_axis - actual_outer_axis) / 2)?;
    let min_start = work_start;
    let max_start = work_end.checked_sub(i64::from(actual_outer_axis))?;
    let placed = centered.clamp(min_start, max_start);
    i32::try_from(placed).ok()
}

pub(crate) fn position_actual_outer(
    work_area: WorkAreaPx,
    actual_outer_size: SizePx,
) -> Option<(i32, i32)> {
    Some((
        position_axis(work_area.x, work_area.width, actual_outer_size.width)?,
        position_axis(work_area.y, work_area.height, actual_outer_size.height)?,
    ))
}

pub(crate) trait StartupWindowOps {
    type Error;

    fn current_monitor_snapshot(&self) -> Result<Option<MonitorSnapshot>, Self::Error>;
    fn primary_monitor_snapshot(&self) -> Result<Option<MonitorSnapshot>, Self::Error>;
    fn frame_delta(&self) -> Result<FrameDeltaPx, Self::Error>;
    fn set_min_inner_size(&self, size: SizePx) -> Result<(), Self::Error>;
    fn set_inner_size(&self, size: SizePx) -> Result<(), Self::Error>;
    fn actual_outer_size(&self) -> Result<SizePx, Self::Error>;
    fn set_outer_position(&self, x: i32, y: i32) -> Result<(), Self::Error>;
    fn center_fallback(&self) -> Result<(), Self::Error>;
    fn show(&self) -> Result<(), Self::Error>;
}

fn valid_monitor_snapshot(snapshot: MonitorSnapshot) -> bool {
    snapshot.scale_factor.is_finite()
        && snapshot.scale_factor > 0.0
        && snapshot.work_area.width > 0
        && snapshot.work_area.height > 0
        && i32::try_from(i64::from(snapshot.work_area.x) + i64::from(snapshot.work_area.width))
            .is_ok()
        && i32::try_from(i64::from(snapshot.work_area.y) + i64::from(snapshot.work_area.height))
            .is_ok()
}

pub(crate) fn initialize_startup_window<W: StartupWindowOps>(window: &W) -> Result<(), W::Error> {
    let current = window
        .current_monitor_snapshot()
        .ok()
        .flatten()
        .filter(|snapshot| valid_monitor_snapshot(*snapshot));
    let selected = current.or_else(|| {
        window
            .primary_monitor_snapshot()
            .ok()
            .flatten()
            .filter(|snapshot| valid_monitor_snapshot(*snapshot))
    });

    let geometry_applied = selected.and_then(|monitor| {
        let frame = window.frame_delta().ok()?;
        let plan = plan_startup_window(monitor, frame)?;
        window.set_min_inner_size(plan.min_inner_size).ok()?;
        window.set_inner_size(plan.inner_size).ok()?;
        let actual_outer = window.actual_outer_size().ok()?;
        let (x, y) = position_actual_outer(monitor.work_area, actual_outer)?;
        window.set_outer_position(x, y).ok()?;
        Some(())
    });

    if geometry_applied.is_none() {
        let _ = window.center_fallback();
    }

    window.show()
}

struct TauriStartupWindow<'a, R: tauri::Runtime> {
    window: &'a tauri::WebviewWindow<R>,
}

fn monitor_snapshot(monitor: tauri::Monitor) -> MonitorSnapshot {
    let work_area = monitor.work_area();
    MonitorSnapshot {
        work_area: WorkAreaPx {
            x: work_area.position.x,
            y: work_area.position.y,
            width: work_area.size.width,
            height: work_area.size.height,
        },
        scale_factor: monitor.scale_factor(),
    }
}

fn invalid_frame_delta() -> tauri::Error {
    std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        "native outer window size is smaller than its inner size",
    )
    .into()
}

impl<R: tauri::Runtime> StartupWindowOps for TauriStartupWindow<'_, R> {
    type Error = tauri::Error;

    fn current_monitor_snapshot(&self) -> Result<Option<MonitorSnapshot>, Self::Error> {
        self.window
            .current_monitor()
            .map(|monitor| monitor.map(monitor_snapshot))
    }

    fn primary_monitor_snapshot(&self) -> Result<Option<MonitorSnapshot>, Self::Error> {
        self.window
            .primary_monitor()
            .map(|monitor| monitor.map(monitor_snapshot))
    }

    fn frame_delta(&self) -> Result<FrameDeltaPx, Self::Error> {
        let inner = self.window.inner_size()?;
        let outer = self.window.outer_size()?;
        Ok(FrameDeltaPx {
            width: outer
                .width
                .checked_sub(inner.width)
                .ok_or_else(invalid_frame_delta)?,
            height: outer
                .height
                .checked_sub(inner.height)
                .ok_or_else(invalid_frame_delta)?,
        })
    }

    fn set_min_inner_size(&self, size: SizePx) -> Result<(), Self::Error> {
        self.window
            .set_min_size(Some(tauri::PhysicalSize::new(size.width, size.height)))
    }

    fn set_inner_size(&self, size: SizePx) -> Result<(), Self::Error> {
        self.window
            .set_size(tauri::PhysicalSize::new(size.width, size.height))
    }

    fn actual_outer_size(&self) -> Result<SizePx, Self::Error> {
        let outer = self.window.outer_size()?;
        Ok(SizePx {
            width: outer.width,
            height: outer.height,
        })
    }

    fn set_outer_position(&self, x: i32, y: i32) -> Result<(), Self::Error> {
        self.window.set_position(tauri::PhysicalPosition::new(x, y))
    }

    fn center_fallback(&self) -> Result<(), Self::Error> {
        self.window.center()
    }

    fn show(&self) -> Result<(), Self::Error> {
        self.window.show()
    }
}

pub(crate) fn initialize_tauri_startup_window<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> tauri::Result<()> {
    initialize_startup_window(&TauriStartupWindow { window })
}

#[cfg(test)]
mod tests {
    use super::{
        initialize_startup_window, plan_startup_window, position_actual_outer, FrameDeltaPx,
        MonitorSnapshot, SizePx, StartupWindowOps, StartupWindowPlan, WorkAreaPx,
    };
    use std::cell::RefCell;

    fn work(x: i32, y: i32, width: u32, height: u32) -> WorkAreaPx {
        WorkAreaPx {
            x,
            y,
            width,
            height,
        }
    }

    fn monitor(work_area: WorkAreaPx, scale_factor: f64) -> MonitorSnapshot {
        MonitorSnapshot {
            work_area,
            scale_factor,
        }
    }

    fn frame(width: u32, height: u32) -> FrameDeltaPx {
        FrameDeltaPx { width, height }
    }

    fn size(width: u32, height: u32) -> SizePx {
        SizePx { width, height }
    }

    fn assert_contained(area: WorkAreaPx, outer: SizePx, position: (i32, i32)) {
        let area_right = i64::from(area.x) + i64::from(area.width);
        let area_bottom = i64::from(area.y) + i64::from(area.height);
        let outer_right = i64::from(position.0) + i64::from(outer.width);
        let outer_bottom = i64::from(position.1) + i64::from(outer.height);

        assert!(i64::from(position.0) >= i64::from(area.x));
        assert!(i64::from(position.1) >= i64::from(area.y));
        assert!(outer_right <= area_right);
        assert!(outer_bottom <= area_bottom);
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum TestError {
        Geometry,
        Show,
    }

    struct FakeWindow {
        calls: RefCell<Vec<&'static str>>,
        current: Result<Option<MonitorSnapshot>, TestError>,
        primary: Result<Option<MonitorSnapshot>, TestError>,
        frame: Result<FrameDeltaPx, TestError>,
        set_min_error: Option<TestError>,
        set_size_error: Option<TestError>,
        actual_outer: Result<SizePx, TestError>,
        position_error: Option<TestError>,
        fallback_error: Option<TestError>,
        show_result: Result<(), TestError>,
        min_sizes: RefCell<Vec<SizePx>>,
        inner_sizes: RefCell<Vec<SizePx>>,
        positions: RefCell<Vec<(i32, i32)>>,
    }

    impl FakeWindow {
        fn success() -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
                current: Ok(Some(monitor(work(0, 0, 1920, 1040), 1.0))),
                primary: Ok(None),
                frame: Ok(frame(16, 39)),
                set_min_error: None,
                set_size_error: None,
                actual_outer: Ok(size(1196, 799)),
                position_error: None,
                fallback_error: None,
                show_result: Ok(()),
                min_sizes: RefCell::new(Vec::new()),
                inner_sizes: RefCell::new(Vec::new()),
                positions: RefCell::new(Vec::new()),
            }
        }

        fn recorded_calls(&self) -> Vec<&'static str> {
            self.calls.borrow().clone()
        }

        fn show_count(&self) -> usize {
            self.calls
                .borrow()
                .iter()
                .filter(|call| **call == "show")
                .count()
        }
    }

    impl StartupWindowOps for FakeWindow {
        type Error = TestError;

        fn current_monitor_snapshot(&self) -> Result<Option<MonitorSnapshot>, Self::Error> {
            self.calls.borrow_mut().push("current");
            self.current
        }

        fn primary_monitor_snapshot(&self) -> Result<Option<MonitorSnapshot>, Self::Error> {
            self.calls.borrow_mut().push("primary");
            self.primary
        }

        fn frame_delta(&self) -> Result<FrameDeltaPx, Self::Error> {
            self.calls.borrow_mut().push("frame");
            self.frame
        }

        fn set_min_inner_size(&self, size: SizePx) -> Result<(), Self::Error> {
            self.calls.borrow_mut().push("set_min");
            self.min_sizes.borrow_mut().push(size);
            self.set_min_error.map_or(Ok(()), Err)
        }

        fn set_inner_size(&self, size: SizePx) -> Result<(), Self::Error> {
            self.calls.borrow_mut().push("set_size");
            self.inner_sizes.borrow_mut().push(size);
            self.set_size_error.map_or(Ok(()), Err)
        }

        fn actual_outer_size(&self) -> Result<SizePx, Self::Error> {
            self.calls.borrow_mut().push("actual_outer");
            self.actual_outer
        }

        fn set_outer_position(&self, x: i32, y: i32) -> Result<(), Self::Error> {
            self.calls.borrow_mut().push("set_position");
            self.positions.borrow_mut().push((x, y));
            self.position_error.map_or(Ok(()), Err)
        }

        fn center_fallback(&self) -> Result<(), Self::Error> {
            self.calls.borrow_mut().push("center_fallback");
            self.fallback_error.map_or(Ok(()), Err)
        }

        fn show(&self) -> Result<(), Self::Error> {
            self.calls.borrow_mut().push("show");
            self.show_result
        }
    }

    #[test]
    fn plans_ideal_window_at_100_percent_scale() {
        let area = work(0, 0, 1920, 1040);
        let plan = plan_startup_window(monitor(area, 1.0), frame(16, 39)).unwrap();

        assert_eq!(
            plan,
            StartupWindowPlan {
                inner_size: size(1180, 760),
                min_inner_size: size(640, 400),
                predicted_outer_size: size(1196, 799),
                effective_margin_x: 16,
                effective_margin_y: 16,
            }
        );
        assert_eq!(
            position_actual_outer(area, plan.predicted_outer_size),
            Some((362, 120))
        );
    }

    #[test]
    fn plans_ideal_window_at_125_percent_scale() {
        let area = work(0, 0, 1920, 1040);
        let plan = plan_startup_window(monitor(area, 1.25), frame(20, 49)).unwrap();

        assert_eq!(
            plan,
            StartupWindowPlan {
                inner_size: size(1475, 950),
                min_inner_size: size(800, 500),
                predicted_outer_size: size(1495, 999),
                effective_margin_x: 20,
                effective_margin_y: 20,
            }
        );
        assert_eq!(
            position_actual_outer(area, plan.predicted_outer_size),
            Some((212, 20))
        );
    }

    #[test]
    fn clamps_150_percent_window_to_a_low_resolution_work_area() {
        let area = work(0, 0, 1366, 728);
        let plan = plan_startup_window(monitor(area, 1.5), frame(24, 59)).unwrap();

        assert_eq!(
            plan,
            StartupWindowPlan {
                inner_size: size(1294, 621),
                min_inner_size: size(960, 600),
                predicted_outer_size: size(1318, 680),
                effective_margin_x: 24,
                effective_margin_y: 24,
            }
        );
        assert_eq!(
            position_actual_outer(area, plan.predicted_outer_size),
            Some((24, 24))
        );
    }

    #[test]
    fn positions_inside_an_offset_work_area_instead_of_the_monitor_origin() {
        let area = work(48, 32, 1872, 1008);
        let plan = plan_startup_window(monitor(area, 1.0), frame(16, 39)).unwrap();
        let position = position_actual_outer(area, plan.predicted_outer_size).unwrap();

        assert_contained(area, plan.predicted_outer_size, position);
        assert!(position.0 > area.x);
        assert!(position.1 > area.y);
    }

    #[test]
    fn positions_inside_a_negative_coordinate_monitor() {
        let area = work(-1920, 0, 1920, 1040);

        assert_eq!(
            position_actual_outer(area, size(1196, 799)),
            Some((-1558, 120))
        );
        assert_contained(area, size(1196, 799), (-1558, 120));
    }

    #[test]
    fn collapses_margin_while_retaining_a_positive_client_area() {
        let area = work(0, 0, 50, 50);
        let plan = plan_startup_window(monitor(area, 1.0), frame(40, 40)).unwrap();

        assert_eq!(
            plan,
            StartupWindowPlan {
                inner_size: size(2, 2),
                min_inner_size: size(2, 2),
                predicted_outer_size: size(42, 42),
                effective_margin_x: 4,
                effective_margin_y: 4,
            }
        );
        assert_eq!(
            position_actual_outer(area, plan.predicted_outer_size),
            Some((4, 4))
        );
    }

    #[test]
    fn rejects_work_areas_consumed_by_the_native_frame() {
        assert!(plan_startup_window(monitor(work(0, 0, 40, 100), 1.0), frame(40, 20)).is_none());
        assert!(plan_startup_window(monitor(work(0, 0, 100, 20), 1.0), frame(10, 20)).is_none());
    }

    #[test]
    fn rejects_invalid_scale_and_work_area_values() {
        for scale_factor in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(plan_startup_window(
                monitor(work(0, 0, 1920, 1040), scale_factor),
                frame(16, 39)
            )
            .is_none());
        }
        assert!(plan_startup_window(monitor(work(0, 0, 0, 1040), 1.0), frame(16, 39)).is_none());
        assert!(plan_startup_window(monitor(work(0, 0, 1920, 0), 1.0), frame(16, 39)).is_none());
        assert!(plan_startup_window(
            monitor(work(0, 0, 1920, 1040), f64::from(u32::MAX)),
            frame(16, 39)
        )
        .is_none());
    }

    #[test]
    fn centers_using_the_actual_outer_size_after_native_rounding() {
        assert_eq!(
            position_actual_outer(work(0, 0, 1920, 1040), size(1198, 801)),
            Some((361, 119))
        );
    }

    #[test]
    fn rejects_an_actual_outer_size_that_exceeds_the_work_area() {
        let area = work(0, 0, 1920, 1040);
        assert!(position_actual_outer(area, size(1921, 800)).is_none());
        assert!(position_actual_outer(area, size(1000, 1041)).is_none());
        assert!(position_actual_outer(area, size(0, 800)).is_none());
        assert!(position_actual_outer(area, size(1000, 0)).is_none());
    }

    #[test]
    fn positions_safely_at_the_signed_lower_boundary() {
        let area = work(i32::MIN, i32::MIN, 100, 100);
        let expected = (i32::MIN + 25, i32::MIN + 25);

        assert_eq!(position_actual_outer(area, size(50, 50)), Some(expected));
        assert_contained(area, size(50, 50), expected);
    }

    #[test]
    fn rejects_a_centered_position_above_the_signed_upper_boundary() {
        assert!(position_actual_outer(work(i32::MAX, 0, 100, 100), size(50, 50)).is_none());
        assert!(position_actual_outer(work(0, i32::MAX, 100, 100), size(50, 50)).is_none());
    }

    #[test]
    fn valid_current_monitor_skips_primary_and_shows_after_positioning() {
        let window = FakeWindow::success();

        assert_eq!(initialize_startup_window(&window), Ok(()));
        assert_eq!(
            window.recorded_calls(),
            vec![
                "current",
                "frame",
                "set_min",
                "set_size",
                "actual_outer",
                "set_position",
                "show",
            ]
        );
        assert_eq!(*window.positions.borrow(), vec![(362, 120)]);
    }

    #[test]
    fn current_monitor_none_uses_primary_monitor() {
        let mut window = FakeWindow::success();
        window.current = Ok(None);
        window.primary = Ok(Some(monitor(work(0, 0, 1920, 1040), 1.0)));

        assert_eq!(initialize_startup_window(&window), Ok(()));
        assert_eq!(
            window.recorded_calls(),
            vec![
                "current",
                "primary",
                "frame",
                "set_min",
                "set_size",
                "actual_outer",
                "set_position",
                "show",
            ]
        );
    }

    #[test]
    fn current_monitor_error_uses_primary_monitor() {
        let mut window = FakeWindow::success();
        window.current = Err(TestError::Geometry);
        window.primary = Ok(Some(monitor(work(0, 0, 1920, 1040), 1.0)));

        assert_eq!(initialize_startup_window(&window), Ok(()));
        assert_eq!(window.recorded_calls()[..2], ["current", "primary"]);
        assert_eq!(window.show_count(), 1);
    }

    #[test]
    fn invalid_current_monitor_uses_primary_monitor() {
        let mut window = FakeWindow::success();
        window.current = Ok(Some(monitor(work(0, 0, 1920, 1040), f64::NAN)));
        window.primary = Ok(Some(monitor(work(0, 0, 1920, 1040), 1.0)));

        assert_eq!(initialize_startup_window(&window), Ok(()));
        assert_eq!(window.recorded_calls()[..2], ["current", "primary"]);
        assert_eq!(window.show_count(), 1);
    }

    #[test]
    fn current_monitor_with_unrepresentable_work_area_end_uses_primary_monitor() {
        let mut window = FakeWindow::success();
        window.current = Ok(Some(monitor(work(i32::MAX, 0, 100, 100), 1.0)));
        window.primary = Ok(Some(monitor(work(0, 0, 1920, 1040), 1.0)));

        assert_eq!(initialize_startup_window(&window), Ok(()));
        assert_eq!(window.recorded_calls()[..2], ["current", "primary"]);
        assert_eq!(window.show_count(), 1);
    }

    #[test]
    fn unusable_primary_monitor_falls_back_then_shows_once() {
        for primary in [
            Ok(None),
            Err(TestError::Geometry),
            Ok(Some(monitor(work(0, 0, 0, 1040), 1.0))),
        ] {
            let mut window = FakeWindow::success();
            window.current = Ok(None);
            window.primary = primary;

            assert_eq!(initialize_startup_window(&window), Ok(()));
            assert_eq!(
                window.recorded_calls(),
                vec!["current", "primary", "center_fallback", "show"]
            );
            assert_eq!(window.show_count(), 1);
        }
    }

    #[test]
    fn selected_150_percent_primary_receives_exact_clamped_sizes() {
        let mut window = FakeWindow::success();
        window.current = Ok(None);
        window.primary = Ok(Some(monitor(work(0, 0, 1366, 728), 1.5)));
        window.frame = Ok(frame(24, 59));
        window.actual_outer = Ok(size(1318, 680));

        assert_eq!(initialize_startup_window(&window), Ok(()));
        assert_eq!(*window.min_sizes.borrow(), vec![size(960, 600)]);
        assert_eq!(*window.inner_sizes.borrow(), vec![size(1294, 621)]);
        assert_eq!(*window.positions.borrow(), vec![(24, 24)]);
        assert_eq!(window.show_count(), 1);
    }

    #[test]
    fn every_geometry_error_falls_back_and_shows_once() {
        let mut frame_error = FakeWindow::success();
        frame_error.frame = Err(TestError::Geometry);

        let mut min_error = FakeWindow::success();
        min_error.set_min_error = Some(TestError::Geometry);

        let mut size_error = FakeWindow::success();
        size_error.set_size_error = Some(TestError::Geometry);

        let mut actual_error = FakeWindow::success();
        actual_error.actual_outer = Err(TestError::Geometry);

        let mut position_error = FakeWindow::success();
        position_error.position_error = Some(TestError::Geometry);

        for window in [
            frame_error,
            min_error,
            size_error,
            actual_error,
            position_error,
        ] {
            assert_eq!(initialize_startup_window(&window), Ok(()));
            assert_eq!(window.show_count(), 1);
            let calls = window.recorded_calls();
            assert_eq!(calls[calls.len() - 2..], ["center_fallback", "show"]);
        }
    }

    #[test]
    fn fallback_center_error_is_ignored_before_the_only_show() {
        let mut window = FakeWindow::success();
        window.current = Ok(None);
        window.primary = Ok(None);
        window.fallback_error = Some(TestError::Geometry);

        assert_eq!(initialize_startup_window(&window), Ok(()));
        assert_eq!(
            window.recorded_calls(),
            vec!["current", "primary", "center_fallback", "show"]
        );
        assert_eq!(window.show_count(), 1);
    }

    #[test]
    fn actual_outer_larger_than_work_area_falls_back_before_showing() {
        let mut window = FakeWindow::success();
        window.actual_outer = Ok(size(1921, 801));

        assert_eq!(initialize_startup_window(&window), Ok(()));
        assert_eq!(
            window.recorded_calls(),
            vec![
                "current",
                "frame",
                "set_min",
                "set_size",
                "actual_outer",
                "center_fallback",
                "show",
            ]
        );
        assert_eq!(window.show_count(), 1);
    }

    #[test]
    fn show_failure_is_returned_unchanged_and_is_the_last_operation() {
        let mut window = FakeWindow::success();
        window.show_result = Err(TestError::Show);

        assert_eq!(initialize_startup_window(&window), Err(TestError::Show));
        assert_eq!(window.recorded_calls().last(), Some(&"show"));
        assert_eq!(window.show_count(), 1);
    }
}
